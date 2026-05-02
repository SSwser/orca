import { describe, expect, it } from 'vitest'
import { resolveWindowsShellLaunchTarget } from './windows-shell-launch'

describe('resolveWindowsShellLaunchTarget', () => {
  it('uses the configured PowerShell implementation for the PowerShell menu item', () => {
    expect(resolveWindowsShellLaunchTarget('powershell.exe', 'pwsh.exe')).toBe('pwsh.exe')
  })

  it('keeps Windows PowerShell when that implementation remains selected', () => {
    expect(resolveWindowsShellLaunchTarget('powershell.exe', 'powershell.exe')).toBe(
      'powershell.exe'
    )
  })

  it('passes through non-PowerShell shells unchanged', () => {
    expect(resolveWindowsShellLaunchTarget('cmd.exe', 'pwsh.exe')).toBe('cmd.exe')
    expect(resolveWindowsShellLaunchTarget('wsl.exe', 'pwsh.exe')).toBe('wsl.exe')
  })
})
