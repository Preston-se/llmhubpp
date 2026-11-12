import { expect, it } from "vitest";
import { SourceManifestStore, type SourceManifest } from "./sourceManifest";
import { ragDigest } from "./localRagStorage";
import { memoryVault } from "./testSupport/memoryVault";

const manifest = (): SourceManifest => ({ version: 1, settingName: "Converted", collectionId: "owner-1", records: {} });

it("refuses a corrupt latest committed generation even when an older manifest is valid", async () => {
  const m = memoryVault(); const store = new SourceManifestStore(m.io as never, "Manifests");
  await store.save(manifest());
  const payload = JSON.stringify({ ...manifest(), records: { A: {} } });
  m.files.set("Manifests/manifest-99999999999999999999.json", JSON.stringify({ payload, hash: await ragDigest(payload) }));
  await expect(new SourceManifestStore(m.io as never, "Manifests").load()).rejects.toMatchObject({ code: "manifest-invalid" });
});

it("does not publish an incomplete write and ignores uncommitted temporary generations", async () => {
  const m = memoryVault(); const store = new SourceManifestStore(m.io as never, "Manifests");
  await store.save(manifest());
  const committed = [...m.files].filter(([path]) => path.endsWith(".json"));
  m.files.set("Manifests/manifest-99999999999999999999.json.tmp", "interrupted");
  expect(await new SourceManifestStore(m.io as never, "Manifests").load()).toEqual(manifest());
  m.fail(".tmp");
  await expect(store.save(manifest())).rejects.toThrow();
  expect([...m.files].filter(([path]) => path.endsWith(".json"))).toEqual(committed);
});
