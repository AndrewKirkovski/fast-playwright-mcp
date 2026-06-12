const config = JSON.stringify({
  name: 'fast-playwright',
  command: 'npx',
  args: ['github:AndrewKirkovski/fast-playwright-mcp'],
});
const urlForWebsites = `vscode:mcp/install?${encodeURIComponent(config)}`;
// Github markdown does not allow linking to `vscode:` directly, so you can use our redirect:
const _urlForGithub = `https://insiders.vscode.dev/redirect?url=${encodeURIComponent(urlForWebsites)}`;
