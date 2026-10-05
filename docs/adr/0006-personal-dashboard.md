# ADR 0006: 自分の端末から使うDona dashboard

- 状態: 採用、実装中
- 決定日: 2026-10-05
- 対象: Epic #139、既存ADR 0002のWeb identity/deployment、ADR 0005の観測専用境界

## 決定と理由

利用者は、このMac以外の自分の端末からも会話とTaskを確認し、依頼・取消・承認を行う。OIDCで複数ユーザーを管理する製品と並存させず、Tailscale等のプライベート接続と、Macで明示的に発行する端末ペアリングに統一する。Dona独自の外部操作承認も今回の完成範囲に含める。

完了済みIssueと旧ADRは履歴として残す。本ADRはWebのOIDC principal、IdP introspection、複数tenant、独立した二者によるWeb登録の要件を置き換える。承認coreの一回限りの消費、保護された監査、exact action検証を取り除く決定ではない。

## 所有者と端末権限

Dispatcherが永続的なinstance IDと単一operator IDを持つ。Task ownerは`local_dashboard`であり、Slack userやworkspaceへ偽装しない。端末IDとgrant revisionは操作の監査に記録し、端末交換でTaskの所有者を変更しない。

Macのowner-only Unix socketからのみ、有効期限5分・一回限りのコードを発行する。発行時に閲覧、worker会話、Dona本体会話、依頼、取消、Codex承認、Dona外部操作承認の権限を選ぶ。既定は閲覧のみ。browserは権限を選択・追加できない。Dona本体の会話には複数のSlack会話が含まれ得るため、worker会話と別の明示権限を使う。

端末grantはDispatcher DBに保存し、cookieとコードはプロセスのメモリにだけ保持する。最大32端末・32session、session期限12時間。logout、Macからの取消、DispatcherまたはWeb service再起動でsessionを失効させる。再登録で枠を消費した場合はMac側で旧端末を取り消す。DB復元だけでcookieを再利用できない。

## 接続と操作

HTTP listenerはloopbackのみ。Tailscale Serve等が設定済みのexact HTTPS originを提供する。公開インターネットへの開放やTailscale identityの自動採用はしない。cookieはSecure/HttpOnly/SameSite=Strict、writeはexact Originとsession-bound CSRFを検証する。BFFは固定されたtyped APIだけをDispatcherのprivate UDSへ渡し、browserからadmin APIを呼べる汎用proxyを作らない。

読み取りは権限をI/Oの前後で確認する。Task/Attempt、App Serverのthread/generationを照合し、過去Attemptは保存済みbindingだけを使う。個人のCodex threadを探索しない。assistantとResult本文は長さを制限したliteral textで表示する。保持期限・欠落・切断を明示し、完全な無期限履歴を保証しない。

依頼と取消は、現在の端末grantを同じDispatcher DB transaction内で検証して、Task更新とreceiptを確定する。request IDは端末へ束縛し、同じIDの異なるpayloadを拒否する。応答が失われたらreceiptを読み、writeを自動再送しない。旧OIDCのanalysis-only ownerを通常host実行へ昇格させない。

workerの質問はDona本体へ届ける。browserの回答もexact Task/Attempt/questionに束縛した入力eventとしてDona本体へ渡す。承認decisionは永続receiptへ固定し、Dona本体が内容を変更した回答を送ることはできない。

## 二種類の承認

Codexのコマンド・ファイル操作承認と、Dona独自の外部操作承認は、別の権限と台帳として表示する。どちらも現在の対象、期限、状態、decisionを確認する。Dona承認は既存coreのtyped operation `slack.post_thread_reply.v1` に限定し、保存済みexact target/draft、現在のアクセス、one-shot consume、実行結果と曖昧状態の記録まで接続する。UI上の許可ボタンだけを完了とはしない。

承認には通常cookieとは別に、対象とdecisionへ束縛した一回限りのWebAuthn確認を要求する。RP IDとoriginは設定値、user verificationは必須。Macが承認権限付きの登録コードを発行した端末だけがcredentialを登録できる。自分用の構成では端末のTouch ID・Face ID・PINで保護したplatform credential/passkeyを許可し、旧ADRのhardware attestation・non-backup必須条件を置き換える。これは単独operator向けの判断であり、独立した二人の承認やIdPと独立した企業向け二者統制を保証しない。credential交換はMacの新たな登録操作に戻す。

承認challengeは2分以内かつrequest期限以内。保存済み対象・decision・device/session/grant revisionへ束縛し、replay、別action転用、失効後回答を拒否する。署名検証後にも現在の権限と対象を照合する。未対応の外部操作、self-update、権限変更、支払い、削除をこの承認で解禁しない。

## 移行と完成証拠

serviceは既存install/updateのrelease artifactに含め、Web再起動でworkerを止めない。旧TaskとResultは保持し、旧ownerを新operatorへ自動変更しない。必要な設定や保護された承認providerが不足した機能は理由付きで利用不可とし、稼働証明には数えない。

最終gateでは、別端末の登録、Slack起点Taskの観察、Web起点の依頼・取消、質問の往復、二種類の承認、失効・切断・再起動・応答喪失を確認する。mainへの統合、稼働release、実際の接続確認を区別して記録する。Epic #26の承認依存は未実装のまま削除しない。
