// bb-plugin-media-viewer backend: turns a file BB is opening (or a `::media`
// directive's file) into BB's own streaming URL for it, plus the other media
// files in the same folder so the viewer can step through them.
import path from "node:path";
import { defineRpcContract, type BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";
import { mediaKind } from "./media.ts";

const sourceSchema = z
  .object({
    kind: z.enum(["host", "thread-storage", "workspace"]),
    threadId: z.string().min(1).nullable(),
    environmentId: z.string().min(1).nullable(),
    projectId: z.string().min(1).nullable(),
    hostId: z.string().min(1).nullable(),
  })
  .strict();
export type MediaSource = z.infer<typeof sourceSchema>;

// Where a file lives, for opening it in BB's right panel.
const targetSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("workspace"), environmentId: z.string(), path: z.string() }).strict(),
  z.object({ kind: z.literal("host"), hostId: z.string(), path: z.string() }).strict(),
  z.object({ kind: z.literal("thread-storage"), threadId: z.string(), path: z.string() }).strict(),
]);
type Target = z.infer<typeof targetSchema>;

const itemSchema = z
  .object({ name: z.string(), kind: z.enum(["image", "video", "audio"]), url: z.string(), target: targetSchema.nullable() })
  .strict();
export type MediaItem = z.infer<typeof itemSchema>;

export const rpcContract = defineRpcContract({
  resolve: {
    input: z.object({ source: sourceSchema, path: z.string().min(1) }).strict(),
    output: z
      .object({
        // The requested file appears at `index` among its folder's media.
        items: z.array(itemSchema),
        index: z.number().int().nonnegative(),
      })
      .strict(),
  },
});

/** A source-relative path with forward slashes and no way out of its root. */
function relativePath(file: string): string {
  const posix = file.replace(/\\/g, "/");
  if (posix.startsWith("/") || /^[a-zA-Z]:\//.test(posix)) throw new Error(`Expected a relative path, got ${file}`);
  if (posix.split("/").includes("..")) throw new Error(`Path must not contain "..": ${file}`);
  const normal = path.posix.normalize(posix);
  if (normal === "." || normal.startsWith("../")) throw new Error(`Path escapes its folder: ${file}`);
  return normal;
}

function absolutePath(file: string): string {
  if (!path.posix.isAbsolute(file)) throw new Error(`Expected an absolute path, got ${file}`);
  if (file.split("/").includes("..")) throw new Error(`Path must not contain "..": ${file}`);
  return path.posix.normalize(file);
}

const encodeSegments = (file: string) => file.split("/").filter(Boolean).map(encodeURIComponent).join("/");

type Location = {
  /** Absolute folder holding the file on `hostId`, when siblings can be listed. */
  folder: { hostId: string; path: string } | null;
  /** BB's file URL and panel target for a file name in the same folder. */
  sibling: (name: string) => { url: string; target: Target | null };
};

export default async function plugin(bb: BbPluginApi) {
  async function threadEnvironment(threadId: string) {
    const thread = await bb.sdk.threads.get({ threadId, include: "environment" });
    const environment = "environment" in thread ? thread.environment : null;
    if (!environment) throw new Error("This thread has no environment.");
    return environment;
  }

  async function locate(source: MediaSource, file: string): Promise<Location> {
    if (source.kind === "thread-storage") {
      if (!source.threadId) throw new Error("A thread-storage file needs its thread.");
      const threadId = source.threadId;
      const relative = relativePath(file);
      const storage = await bb.sdk.threads.storageLocation({ threadId });
      const dir = path.posix.dirname(relative);
      return {
        folder: { hostId: storage.hostId, path: path.posix.join(storage.storageRootPath, dir) },
        sibling: (name) => {
          const next = dir === "." ? name : `${dir}/${name}`;
          return {
            url: `/api/v1/threads/${encodeURIComponent(threadId)}/thread-storage/files/${encodeSegments(next)}`,
            target: { kind: "thread-storage", threadId, path: next },
          };
        },
      };
    }
    if (source.kind === "workspace") {
      const relative = relativePath(file);
      const dir = path.posix.dirname(relative);
      const join = (name: string) => (dir === "." ? name : `${dir}/${name}`);
      let environmentId = source.environmentId;
      if (!environmentId && !source.projectId && source.threadId) environmentId = (await threadEnvironment(source.threadId)).id;
      if (environmentId) {
        const environment = await bb.sdk.environments.get({ environmentId });
        const id = environmentId;
        return {
          folder: environment.path ? { hostId: environment.hostId, path: path.posix.join(environment.path, dir) } : null,
          sibling: (name) => ({
            url: `/api/v1/environments/${encodeURIComponent(id)}/files/${encodeSegments(join(name))}`,
            target: { kind: "workspace", environmentId: id, path: join(name) },
          }),
        };
      }
      if (!source.projectId) throw new Error("A workspace file needs its environment or project.");
      const base = source.hostId
        ? `/api/v1/projects/${encodeURIComponent(source.projectId)}/hosts/${encodeURIComponent(source.hostId)}/files/`
        : `/api/v1/projects/${encodeURIComponent(source.projectId)}/files/`;
      return {
        folder: null,
        sibling: (name) => ({ url: base + encodeSegments(join(name)), target: null }),
      };
    }
    const absolute = absolutePath(file);
    let hostId = source.hostId;
    if (!hostId && source.environmentId) hostId = (await bb.sdk.environments.get({ environmentId: source.environmentId })).hostId;
    if (!hostId && source.threadId) hostId = (await bb.sdk.threads.storageLocation({ threadId: source.threadId })).hostId;
    if (!hostId) hostId = (await bb.sdk.system.config()).primaryHostId;
    if (!hostId) throw new Error("Could not tell which machine holds this file.");
    const host = hostId;
    const dir = path.posix.dirname(absolute);
    return {
      folder: { hostId: host, path: dir },
      sibling: (name) => {
        const next = path.posix.join(dir, name);
        return { url: `/api/v1/hosts/${encodeURIComponent(host)}/files/${encodeSegments(next)}`, target: { kind: "host", hostId: host, path: next } };
      },
    };
  }

  bb.rpc.register(rpcContract, {
    async resolve({ source, path: file }) {
      const name = path.posix.basename(file.replace(/\\/g, "/"));
      const kind = mediaKind(name);
      if (!kind) throw new Error(`Not an image, video or audio file: ${name}`);
      const location = await locate(source, file);
      const self: MediaItem = { ...location.sibling(name), name, kind };
      let names: string[] = [];
      if (location.folder) {
        try {
          const listing = await bb.sdk.hosts.directory(location.folder);
          names = listing.entries.filter((entry) => entry.kind === "file" && mediaKind(entry.name)).map((entry) => entry.name);
        } catch (error) {
          // Stepping through the folder is a convenience; still show the file.
          bb.log.warn(`could not list media folder: ${String(error)}`);
        }
      }
      if (!names.includes(name)) names.push(name);
      names.sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
      const items = names.map((entry) => (entry === name ? self : { ...location.sibling(entry), name: entry, kind: mediaKind(entry)! }));
      return { items, index: names.indexOf(name) };
    },
  });
}
