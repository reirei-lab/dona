# ADR 0005: プライベート接続で使う観測専用dashboard

- 状態: 採用。実サービスの公開・端末接続確認は別の運用手順で行う。
- 決定日: 2026-10-05
- 対象: Epic #139、#372、#373、#374、#146

## 決定

ユーザーが別端末から作業状況を見るため、Tailscale等のプライベート接続と端末ペアリングを使う観測専用モードを追加する。OIDCをこのモードの必須条件にしない。既存ADR 0002のmulti-principal command/approvalモードは維持し、ペアリングからその操作権限を得ることはできない。

```text
登録済み端末のbrowser
  -> Tailscale ServeのHTTPS endpoint
  -> Macの127.0.0.1固定observer
     -> Dispatcher DBのreadonly snapshot
     -> Runtime hostのDona所有会話read API
```

Tailscale Serveはtailnet内の接続をローカルserviceへ転送する。Funnelによるインターネット公開は本モードの運用対象にしない。HTTPS終端・アクセス制御の設定と接続先originはoperatorが固定する。[Tailscale Serve公式仕様](https://tailscale.com/docs/features/tailscale-serve)

## 権限とセッション

Mac上のprivate UDS（親directory 0700、socket 0600、current UID）からoperatorが5分・一回限りの接続コードを発行する。コードを渡すことは、このDonaの全Taskとworker会話へのread-only閲覧をその端末へ許可する行為である。UIにこの範囲を明示する。複数利用者のTaskを隔離する用途にはこのモードを使用せず、ADR 0002のowner/grant契約を使う。

コードはURL・サービスlog・GitHubへ保存しない。browserはsame-origin POSTでコードを交換し、HttpOnly・Secure・SameSite=Strict cookieを受け取る。コード照合は一定時間比較、試行回数制限付き。sessionはメモリのみ、最大12時間、最大16件とし、logout、operator revoke、service再起動で失効する。DB rollbackからsessionが復活しないため、承認用external anchorをobserverの起動条件にしない。

Hostは設定済みHTTPS originのhostへ固定する。POSTはexact Originを要求し、logoutはsession-bound CSRF tokenも要求する。ForwardedヘッダーやTailscale user名をauthorityとして採用しない。backendをLAN addressへbindしない。未認証browser・別originへprivate responseを返さず、CORSを許可しない。

## 読み取りと表示

- DispatcherのTaskが状態の正本。Attemptの状態・Taskの待機理由・runtime接続状態を別々に表示する。
- observerはSQLiteをreadonly/query_onlyで開く。migration、recovery、supervisor、Result書き込みを起動しない。
- runtimeのagent名、generation、Dona job/Attempt、threadを照合する。個人Codexのthread一覧を使わない。
- 履歴取得によるstart/resume/質問回答/取消は行わない。runtime切断をTaskのfailedへ変換しない。
- API await後にsessionとTask snapshotを再照合し、失効・Attempt変更前の本文を返さない。
- user/system/developer promptとtool入力・出力を除外する。assistant本文は会話閲覧を許可された端末だけへliteral textとして表示する。assistant自身が秘密を文章に含めた場合まで完全に除去できるとは主張しない。
- HTMLは固定CSP、textContent表示、no-store、no-referrerとする。offline、失効、bfcache復帰ではprivate viewを消して再検証する。
- UIは5秒pollで最新snapshotを再取得する。通知の完全再送を保証しない。runtimeの保持gapとtruncatedを表示し、保存済みcursorが無い再接続を完全履歴と扱わない。

## 公開範囲と残境界

初期observerはworker会話の閲覧に限定する。複数Slack利用者・channelを含むdona-main会話、過去Attemptの会話選択、OIDC principal別grants、Web command/approvalはそれぞれ既存Issueの残作業であり、observerの完成をEpic全体の完了にしない。

serviceは独立して再起動でき、workerを停止しない。releaseは既存Web packageを含める。実際のTLS/private接続、別端末登録、worker稼働中のservice再起動を確認するまでは本番利用確認済みとしない。
