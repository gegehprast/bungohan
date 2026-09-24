import { expect, test } from "bun:test"
import { join } from "node:path"
import { ROOT, VERSION_NOTES, version, versionsNamed } from "./packages"

test.each([...VERSION_NOTES])(
  "%s names the manifests' version",
  async (file) => {
    const text = await Bun.file(join(ROOT, file)).text()
    const named = versionsNamed(text)
    expect(named.length).toBeGreaterThan(0)
    for (const v of named) expect(v).toBe(await version())
  },
)
