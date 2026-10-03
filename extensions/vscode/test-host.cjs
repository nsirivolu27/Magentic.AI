const assert = require('node:assert/strict');
const { writeFileSync } = require('node:fs');
const { resolve } = require('node:path');
const vscode = require('vscode');
exports.run = async function () {
  const report = resolve(__dirname, '../../dist/vscode/host-test-result.json');
  try {
    const extension = vscode.extensions.getExtension('magenticai.magentic-workspace');
    assert.ok(extension, 'VSIX manifest is discovered');
    await extension.activate();
    const commands = await vscode.commands.getCommands(true);
    for (const command of ['magentic.open', 'magentic.explainSelection', 'magentic.proposeEdit']) assert.ok(commands.includes(command), command);
    await vscode.commands.executeCommand('magentic.open');
    const document = await vscode.workspace.openTextDocument(vscode.Uri.parse('magentic-proposal:/test/unavailable'));
    assert.equal(document.getText(), '');
    writeFileSync(report, JSON.stringify({ passed: true, checks: ['extension activation', 'registered commands', 'sidebar view opened', 'native diff content provider'], vscode: vscode.version }, null, 2));
  } catch (error) {
    writeFileSync(report, JSON.stringify({ passed: false, error: String(error) }));
    throw error;
  }
};
