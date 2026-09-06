# Codex model router

Codex Desktop または Codex CLI と App Server の間で通信を中継し、新規ターンに限ってモデル設定を適用するローカルツールです。会話、承認、履歴は既存の仕組みをそのまま使います。

## 現在の安全設定

`config.json` の既定は `"mode": "observe"` です。この状態では通信を書き換えず、モデル推奨と判定理由だけを診断ログへ記録します。自由文中の語句は参考情報にしか使わず、Astra への自動昇格条件にはしません。

対応するモードは次の3つです。

- `observe`: 受信したモデル設定を維持する
- `fixed`: `fixedModel` を新規ターンへ適用する
- `auto`: 確認済みの未解決理由が `escalatedThreads` にある会話は Astra、それ以外は Sol を適用する

モデル別の既定 effort は Sol、Astra ともに `high` です。`requestModelPolicy` が `preserve` の場合、Desktop から届いた `model` または `effort` をユーザー指定として最優先します。モデルだけを指定した場合は、そのモデルに対応する `efforts` の既定値を補います。モデルと effort の両方を指定した場合はその組み合わせを使います。

会話固定は `threadPins` でも指定できます。Desktop が送る既定値とユーザー操作を実機で区別できると確認するまでは、安全側の `preserve` を維持してください。`threadPins` を Desktop の送信値より優先したい検証時だけ `requestModelPolicy` を `replace` にします。

## 起動

実行権限を付けた後、まず互換性を確認します。

```sh
asp check
```

Desktop を通常起動している場合は、実行中タスクを保護するため起動を拒否します。Desktop を手動で終了した後、対象リポジトリで起動します。`.zshrc` を読み込み済みなら、どちらも実行時のカレントディレクトリを対象にします。

```sh
cd /path/to/repository
asp app
```

CLI 版も同じルーターを経由します。通常の Codex CLI オプションはそのまま後ろへ渡せます。

```sh
cd /path/to/repository
asp
asp --search
```

通常起動へ戻すには、タスクを整理して Desktop を終了し、次回は通常の `codex app` を使います。アプリ本体やグローバル環境は変更しません。

CLI 版の接続には [Codex App Server](https://learn.chatgpt.com/docs/app-server) のローカル Unix WebSocket を使います。この接続方式は現時点では実験的です。

## 設定と記録

対象リポジトリ、モデル、effort、固定指定は `config.json` で管理します。対象判定は有効化した絶対パスとその配下だけです。対象不明、対象外、サブエージェント、実行中ターンへの追加入力、未対応 CLI では設定を変更しません。

状態と本文を含まない診断ログは次に保存されます。

```text
~/Library/Application Support/codex-model-router/state.json
~/Library/Application Support/codex-model-router/router.jsonl
```

テスト用には `CODEX_MODEL_ROUTER_CONFIG`、`CODEX_MODEL_ROUTER_STATE_DIR`、`CODEX_MODEL_ROUTER_INNER_CODEX` で保存先や実行ファイルを差し替えられます。

## 検証

```sh
npm test
npm run check
```

単体テストの合格は Desktop 接続成立を意味しません。初回は `observe` で会話、承認、追加入力、中断、添付、複数タスクを実機確認し、その後に固定モデルの Sol → Astra → Sol を確認してください。
