# model-router

メインエージェントが同じタスクの途中で自律的にモデルを切り替えて作業を自動続行するローカル中継

## 起動

起動したいディレクトリに移動して起動する

```sh
cd /Users/[user_name]/[directory] /Users/[user_name]/model-router/bin/model-router
```

カレントディレクトリで起動したい場合は `cd` を省略する

```sh
/Users/[user_name]/model-router/bin/model-router
```

`app` オプションをつけるとデスクトップアプリと中継機能が起動する

```sh
/Users/[user_name]/model-router/bin/model-router app
```

## 設定と移行

- `config.json` は本番用・Git管理対象外です。`config_sample.json` はひな形
- 対象ディレクトリの path を `enabledRepositories` に絶対パスで登録する
- 切り替え先は `models` にモデル名をキーとして登録し、各モデルの `effort` に既定の思考量を指定する。旧 `efforts` 形式は使用しない
- 選択モデルの設定は、Codexの実行開始要求へまとめて渡す。項目の追加に中継のコード変更は不要。項目名・値は使用中のCodexが対応するものを指定する（[公式仕様](https://learn.chatgpt.com/docs/app-server#turns)）。未対応項目が有効になるわけではない
- 通常の開始時は利用者の明示指定を優先し、未指定項目へモデル別の既定値を補う。自律的なモデル変更時は切り替え先の設定を適用する。未指定項目はCodexの引き継ぎ規則に従うため、モデル間で戻したい値も明示する
- タスク識別・会話入力・権限・作業場所・作業指示など、中継が維持する制御項目はモデル設定から上書きできない。不正な指定は読み込み時に拒否する
- Codexが設定を受け付けても、モデル側でそのまま使われる保証とは異なる。0.153.4の実機では `summary: "concise"` の受付通知を確認した一方、実行記録は `summary: "auto"` だった。中継は値を書き換えず送信する
- 設定ファイルの編集は、中継の次回起動時に読み込まれる
- 配布元のモデル選択基準は AI に指示、もしくは設定する

## 記録と検証

- タスク・適用モデルの永続化はエージェント本体に任せる
- 診断ログは `~/Library/Application Support/codex-model-router/router.jsonl`
- `CODEX_MODEL_ROUTER_CONFIG`、`CODEX_MODEL_ROUTER_STATE_DIR`、`CODEX_MODEL_ROUTER_INNER_CODEX` で試験用の設定・保存先・実行ファイルを指定できる

```sh
npm test
npm run check
# 実際のモデルを使用し、利用枠を消費する試験
MODEL_ROUTER_LIVE=1 npm test -- -t '実機で同一タスク'
```
