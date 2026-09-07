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
- 設定は全体を受け取り、モデル内を含む追加項目も保持する。ただし、Codexへ送るのは対応済みの項目だけ。項目を追加しただけでは動作に反映されない
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
