// The real entry point, run the way agents run it: through scripts/wt, from a skill directory that is a symlink.
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, expect, it } from "vitest";

const REPO = resolve(import.meta.dirname, "../..");
let tmp: string | null = null;

afterEach(() => {
  if (tmp) rmSync(tmp, { recursive: true, force: true });
  tmp = null;
});

it("regression: CLI prints nothing when started through a symlink", () => {
  tmp = mkdtempSync(join(tmpdir(), "wt-launcher-"));
  mkdirSync(join(tmp, "skills"));
  const link = join(tmp, "skills", "wiki-trends");
  symlinkSync(REPO, link, "dir");

  const res = spawnSync(join(link, "scripts/wt"), ["analyze", "--topic", "Astronomy", "--langs", "uk", "--out-dir", tmp], {
    env: { ...process.env, WT_FAKE_API: "1" },
    encoding: "utf8",
    timeout: 25_000,
  });

  expect(res.stderr).not.toMatch(/^\s+at .+:\d+:\d+\)?$/m); // no stack trace
  expect(res.status, res.stderr).toBe(0);
  const lines = res.stdout.split("\n").filter(Boolean);
  expect(lines, res.stdout).toHaveLength(1);
  const out = JSON.parse(lines[0]!) as { ok: boolean; caveats: string[] };
  expect(out.ok).toBe(true);
  expect(out.caveats[0]).toMatch(/^SYNTHETIC TEST DATA/);
});
