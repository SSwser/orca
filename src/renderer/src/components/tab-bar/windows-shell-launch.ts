export function resolveWindowsShellLaunchTarget(
  shell: 'powershell.exe' | 'cmd.exe' | 'wsl.exe',
  powerShellImplementation: 'powershell.exe' | 'pwsh.exe'
): string {
  if (shell !== 'powershell.exe') {
    return shell
  }

  return powerShellImplementation
}
