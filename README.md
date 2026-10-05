# Dona

Donaは、外部イベントを1つの秘書エージェントへ安全に直列投入するためのローカル実行基盤です。

```text
Slack Socket Mode -> sources/slack Adapter -> UDS HTTP -> dispatcher -> SQLite -> Runtime host -> Codex App Server (dona-main)
                                                         dona-main -> sources/slack MCP -> Slack Web API
                                                         dona-main -> dispatcher MCP -> background Codex jobs
                                                         dona-main -> dispatcher MCP -> stable updater
stable updater -> immutable release -> ordered restart -> dona_update completion -> dispatcher
```

- [`dispatcher/`](./dispatcher/README.md): 永続キュー、`dona-main`への直列投入、バックグラウンドJob supervisor、別プロセスのstdio MCP
- [`sources/slack/`](./sources/slack/README.md): Socket Mode Adapterと、同じKeychain認証を使う別プロセスのstdio MCP
- [`sources/web/`](./sources/web/README.md): 実装中のWeb認証・session保護部品。listenerと監査付きsession保存は後続で接続
- [`updater/`](./updater/README.md): 更新対象から独立したstable controller、専用SQLite/outbox、immutable release、activation/rollback

Slack AdapterはRuntime hostやSQLiteを直接操作しません。Dispatcherからエージェントへの入口は一方向です。エージェントがSlack操作を選んだ場合は、別プロセスのDona Slack MCPを使います。

## 開発時の起動

依存関係のインストールは初回だけ各パッケージで行います。

```sh
npm --prefix dispatcher install
npm --prefix sources/slack install
npm --prefix updater install
```

以降はリポジトリのルートから1コマンドで起動できます。

```sh
npm run dev
```

開発ランチャーはRuntime host、App Serverのdona-main、Dispatcher、Slack Adapterを起動します。事前に`npm run build`を実行してください。MCPは各packageの`.env`を利用します。Herdrの手動起動は不要です。

`Ctrl+C`では受付とDispatcherを停止し、その後Runtime hostが所有するagentのprocess停止を確認します。本番とは異なるDB・socket・worktree設定を各packageの`.env`へ指定してください。既存hostとsocketを共有して起動することはできません。

## 本番の移行・更新

Herdrからの移行とRuntime host自体の更新は、[`scripts/dona-update`](./scripts/dona-update)の既存DB保持経路を使います。旧processの停止、WAL整合backup、新世代の準備、4つのLaunchAgentとmainの起動確認を順に行います。Task・worktree・Resultは保持します。実行引数と再開手順は`./scripts/dona-update --help`で確認してください。

[`App Server設計`](docs/design/app-server-runtime.md)に質問・承認・復旧の契約と検証範囲を記載しています。workerの質問はdona-mainへ届き、必要な場合だけSlackの元threadで利用者へ確認します。

`install-self-update.sh`、`install-launchd.sh`および旧Herdrのrunbookは旧世代の導入・復旧用です。App Server世代の通常起動には使いません。routine self-updateはstable hostを残してmainとアプリのreleaseを切り替えますが、既存の保守的なworker safety判定により拒否される場合は外部更新を使います。

## Web Adapterの設計

[Web trust boundary ADR](./docs/adr/0002-web-trust-boundary.md)と[decision / deployment fixture](./docs/adr/fixtures/web-trust-boundary.md)に、identity・tenant・session・approvalの契約を記載しています。設計成果物であり、Web runtimeやapproval実行の有効化ではありません。

[Supervisor approval ADR](./docs/adr/0001-supervisor-approval.md)と[contract fixture](./docs/adr/fixtures/supervisor-approval-contracts.md)に、承認のtrust boundary、lifecycle、UX、運用方針、release gateを記載しています。

## 全体検証

```sh
npm run verify
```

Web認証部品の検証は `npm --prefix sources/web ci` の後、rootの `npm run verify:web` で行う。この段階では開発launcherやrelease manifestへWeb serviceを接続せず、通常の `npm run dev` は既存serviceだけを起動する。
