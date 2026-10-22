import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";

// The Windows scripts cannot run here, so this guards the names they must
// agree on: the single-instance mutex, the Start menu shortcut, the
// Apps & features registry key, and the files each package must carry.
// Tests run from the repository root; the scripts are not compiled, so they
// are read from the source tree rather than next to this test's build output.
const script = (name: string) => readFile(join(process.cwd(), "workbench", "desktop", name), "utf8");

test("installer, launcher and uninstaller agree on shared Windows names", async () => {
  const [install, start, uninstall] = await Promise.all([script("Install.ps1"), script("Start-Magentic.ps1"), script("Uninstall.ps1")]);
  const mutex = "Local\\MagenticDeveloper-$identity";
  assert.ok(start.includes(mutex) && uninstall.includes(mutex));
  const shortcut = "'Magentic Developer.lnk'";
  assert.ok(install.includes(shortcut) && uninstall.includes(shortcut));
  const key = "HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\MagenticDeveloper";
  assert.ok(install.includes(key) && uninstall.includes(key));
  // The uninstaller refuses to delete a folder that is not an installation.
  for (const required of ["version.json", "launcher.mjs", "Start-Magentic.ps1"]) assert.ok(uninstall.includes(`'${required}'`));
});

test("package build ships every script the installer and uninstaller rely on", async () => {
  const [build, install] = await Promise.all([script("build.mjs"), script("Install.ps1")]);
  for (const name of ["Install.ps1", "Install.cmd", "Uninstall.ps1", "Uninstall.cmd", "Start-Magentic.ps1", "README.txt", "RELEASE-NOTES.txt"]) {
    assert.ok(build.includes(`"${name}"`), `${name} is copied into the package`);
  }
  assert.ok(build.includes('"version.json"'));
  // The notes name the version the package carries, so a stale file is caught here.
  const [notes, pkg] = await Promise.all([script("RELEASE-NOTES.txt"), readFile(join(process.cwd(), "package.json"), "utf8")]);
  assert.ok(notes.includes(`\n${JSON.parse(pkg).version} `), "release notes have an entry for the package version");
  assert.ok(install.includes("'version.json'"));
  // The installer never overwrites and never asks for administrator rights.
  assert.ok(install.includes("existing installations are never overwritten"));
  assert.ok(!/HKLM:|Start-Process[^\n]*-Verb RunAs/.test(install));
});
