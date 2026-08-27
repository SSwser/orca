import type { ElectronApplication, TestInfo } from '@stablyai/playwright-test'

export function forwardElectronProcessLogs(app: ElectronApplication, testInfo: TestInfo): void {
  if (process.env.ORCA_E2E_FORWARD_APP_LOGS !== '1') {
    return
  }

  const child = app.process()
  const prefix = `[electron:${testInfo.title}]`
  child.stdout?.on('data', (chunk: Buffer) => {
    console.log(`${prefix} stdout: ${chunk.toString().trimEnd()}`)
  })
  child.stderr?.on('data', (chunk: Buffer) => {
    console.error(`${prefix} stderr: ${chunk.toString().trimEnd()}`)
  })
  child.on('exit', (code, signal) => {
    console.log(`${prefix} exit: code=${code ?? 'null'} signal=${signal ?? 'null'}`)
  })
}
