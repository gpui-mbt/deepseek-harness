---
kind: upgrade-guide
description: "永続 dot が内蔵化されました。外部の @f12o/dsh-dots バンドルを置き換え、ツール名を維持し、registry の一回限りの取り込みでレコードを dots ストレージドメインへ移行します。"
---

# 永続 dot が内蔵化されました

[English](guide.md) | 中文

## 变更

永続的な名前付きエージェントがインストールの一部になりました。`@deepseek-ai/dsh-dots`（Host サービス、ストレージドメイン、ツールガード、`dots` Remote 名前空間）と `@deepseek-ai/dsh-tool-dots`（モデル向け 6 ツール）が `dsh-web-app` に入り、Web パネル用に `@deepseek-ai/dsh-client-ui-dots` が加わります。外部の `@f12o/dsh-dots` バンドルを併用すると、同じレコードとツールを所有する行が二重にマウントされます。2 つ目の `dotsController` 登録は失敗し、重複ツールは拒否されます。

内蔵サービスは公開済みのツール名（`dot_create`、`dot_list`、`dot_assign`、`dot_update`、`dot_schedule`、`dot_archive`）と dot ディレクトリ配置を維持するため、既存の dot とプリセットはそのまま動作します。次の 3 つの契約が変わります:

- **単一ホストのみ。** peer/fleet 層（`hosts.json`、`host` 引数、リモート選択）はなくなりました。
- **ストレージの移動。** レコードは `$DSH_HOME/dots/registry.json` ではなく `dots` ストレージドメインに保存されます。初回有効化時に従来の registry を一度だけ取り込み、`registry.json.imported` に改名します。
- **割り当てはキューイングされたプロンプト。** 配信は Session controller の通常の `user-rpc` プロンプトを使うため、dot id は専用のメッセージソースではなく `[DOT ASSIGNMENT]` フレームに載ります。

## 迁移

1. 外部バンドルを削除します: `$DSH_HOME/profiles/<name>/package.json` を編集し、`dsh.profile.bundles` と `dependencies` から `@f12o/dsh-dots` を削除します。
2. そのプロファイルの `cordis.patch.yml` から外部の `dots` 行を削除します。内蔵行は `dsh-web-app` の `id: dots` です。`hostsFile`、`peer`、`requestTimeoutMs` フィールドは存在しなくなるため削除します。`root`、`defaultPreset`、`defaultPermissionPreset`、バイト上限、`enforceToolAllowlist` は意味を保つため維持します。
3. dot ディレクトリはそのまま残します。初回有効化時に `<root>/registry.json` が検証されてストレージへ取り込まれ、`<root>/registry.json.imported` に改名されます。空でないテーブルの隣に現れた registry はログに記録され、そのまま残ります。手作業で突き合わせてから改名してください。
4. ホストを再起動し、`dsh` のログが取り込み件数を一度だけ報告し、以降の起動では何も出さないことを確認します。
5. 新しい **dots** サイドバーパネルを開き、dot とライブ状態が表示されることを確認します。外部スケジュールの自動移行はありません。旧バンドルが所有していたスケジュールは `dot_schedule` で作り直すか、Schedule サービスが取り込んだことを確認してください。
6. 外部ツールを列挙していたプリセットは同じ名前を保つため、変更は不要です。dot は引き続き `dot_*` ツールを呼べず、`allowedTools` は実行時に強制されます（dot から派生した生きた subagent セッションも対象になりました）。
