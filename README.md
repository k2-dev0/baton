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
- 切り替え先は `models` にモデル名をキーとして登録し、各モデルの `effort` に既定の思考量を指定する
- 選択モデルの設定は、Codexの実行開始要求へまとめて渡す。項目の追加に中継のコード変更は不要。項目名・値は使用中のCodexが対応するものを指定する（[公式仕様](https://learn.chatgpt.com/docs/app-server#turns)）。未対応項目が有効になるわけではない
- `effort` の個別処理は、モデルが対応する思考量の確認と、Codexの作業モード内の思考量との同期用。追加設定の転送先を限定する処理ではない。設定一式は続行時の実行開始要求へ渡す
- 通常の開始時は利用者の明示指定を優先し、未指定項目へモデル別の既定値を補う。自律的なモデル変更時は切り替え先の設定を適用する。未指定項目はCodexの引き継ぎ規則に従うため、モデル間で戻したい値も明示する
- タスク識別・会話入力・権限・作業場所・作業指示など、中継が維持する制御項目はモデル設定から上書きできない。不正な指定は読み込み時に拒否する
- Codexが設定を受け付けても、モデル側でそのまま使われる保証とは異なる。0.153.4の実機では `summary: "concise"` の受付通知を確認した一方、実行記録は `summary: "auto"` だった。中継は値を書き換えず送信する
- 設定ファイルの編集は、中継の次回起動時に読み込まれる
- 配布元のモデル選択基準は AI に指示、もしくは設定する
- `supportedCliVersions` の登録・更新は不要。旧設定に残っていても互換性判定には使わない
- 起動するCodex自身から実験的機能を含む通信仕様を生成し、中継に必要な操作・項目・基本的な型・実行状態を確認する。仕様生成の失敗・5秒の時間切れ・必須機能の欠落は理由を表示して起動を拒否する。検査ではタスクを作らず、推論も行わない
- この検査は中継が使う通信契約の確認であり、将来のCodexの動作すべてを保証するものではない。通信方式自体が変わった場合は中継側の対応が必要

## 記録と検証

- タスク・適用モデルの永続化はエージェント本体に任せる
- 診断ログは `~/Library/Application Support/codex-model-router/router.jsonl`
- `CODEX_MODEL_ROUTER_CONFIG`、`CODEX_MODEL_ROUTER_STATE_DIR`、`CODEX_MODEL_ROUTER_INNER_CODEX` で試験用の設定・保存先・実行ファイルを指定できる

```sh
npm test
npm run check
# インストール済みCodexの通信仕様を確認（推論なし）
./bin/model-router check
# 実際のモデルを使用し、利用枠を消費する試験
MODEL_ROUTER_LIVE=1 npm test -- -t '実機で同一タスク'
```
