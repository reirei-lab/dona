/** workerへ親Dispatcher/Slackのcredentialや管理endpointを継承しない。
 * モデル/GitHubなど元作業に必要な認証の契約は変更しない。 */
export function workerEnvironment(source:NodeJS.ProcessEnv):NodeJS.ProcessEnv {
  return Object.fromEntries(Object.entries(source).filter(([key,value])=>
    !/^(?:DONA_|SLACK_|HERDR_)/i.test(key)&&!(typeof value==="string"&&/^xox[baprs]-/i.test(value))));
}
