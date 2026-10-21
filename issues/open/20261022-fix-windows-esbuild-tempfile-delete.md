# Windowsでesbuildの大入力変換が一時ファイル削除エラーになる問題を修正する

Status: open
Model: GPT-5
Created: 2026-10-22
Updated: 2026-10-22
Branch: fix/20261022-windows-esbuild-tempfile-delete

## 概要

Windowsの制限された実行環境でも、esbuildが1 MiBを超える入力を変換できるようにし、`pnpm run dev:web`の初回ビルドと監視ビルドを安定して起動できるようにする。

## 背景

Viteが使用するesbuildは、1 MiBを超える変換入力を一時ファイルに書き、ネイティブesbuildプロセスへパスを渡す。Windowsでネイティブ子プロセスによるファイル削除が制限される環境では、この処理が`remove <temp-path>: Access is denied.`で失敗する。Web buildではesbuild 0.25.12、VitePressのdocumentation buildではesbuild 0.21.5から同じエラーが発生した。リポジトリはすでに[`patchedDependencies`](../../pnpm-workspace.yaml)と[`patches/`](../../patches/)を依存パッケージの限定的な修正に使用している。

再現時には、1,048,575 bytesの入力は変換でき、1,048,577 bytesの入力は削除エラーになった。`TEMP`と`TMP`を別の書き込み可能なディレクトリへ変更しても失敗し、Node.jsプロセス自身による作成直後のファイル削除は成功した。`node_modules`内のesbuildで大入力の一時ファイル退避を無効化すると、`pnpm run build:web`、`vp run dev:web --host 100.111.219.110 --port 8080`、認証済みWeb応答が成功した。

## 問題

現在のWebビルドとdocumentation buildは、入力サイズが1 MiBを超えたときにネイティブesbuildプロセスが一時ファイルを削除できることへ依存している。この権限がないWindows環境では、生成対象や一時ディレクトリが書き込み可能でも`build:artifacts`のWeb buildと`doc-sync`のdocumentation buildが停止し、`dev:web`は監視プロセスとWebサーバーを起動できない。Viteのチャンク構成によって偶然1 MiB未満に保つ方法では、依存関係やソースの増加で再発する。

## 目標

Windowsのネイティブesbuildプロセスに一時ファイル削除権限がない場合でも、大入力の変換、Web成果物とドキュメントサイトのビルド、`dev:web`の監視起動を完了させる。通常のWindows、macOS、Linuxにおける成果物の内容と対応ブラウザー範囲は維持する。

## 対象外

- Git hookを`.git/dsh-hooks`へインストールできない権限問題
- Webバンドルのサイズ最適化やロード性能の改善
- Windows Defender、EDR、またはCodex実行環境の全体的な権限設定
- esbuildの開発サーバー機能

## 提案する方針

1. Web buildとdocumentation buildが解決する各esbuild版について、Viteと互換性のある更新版で同じ大入力変換を確認し、上流だけで解消できる場合は依存関係を更新する。
2. 更新版でも一時ファイル退避が残る場合は、`pnpm-workspace.yaml`の`patchedDependencies`を使用し、Windowsでは1 MiB超の変換入力を既存のIPC経路で渡す限定的なesbuildパッチを対象版ごとに追加する。macOSとLinuxの大入力処理は変更しない。
3. パッチには対象esbuild版、上流実装への参照、削除権限がないWindows環境で必要な理由を記載する。esbuild更新時にパッチの要否を再評価できるようにする。
4. 1 MiB境界の回帰テストを追加し、ネイティブWindowsのWeb buildと`dev:web`起動で実際のVite経路を確認する。

## 受け入れ条件

- [ ] Windowsで1,048,577 bytes以上のJavaScript入力をesbuild APIで変換しても、一時ファイルの`Access is denied`エラーにならない。
- [ ] Windowsで`pnpm run build:web`が成功する。
- [ ] Windowsで`pnpm run doc-sync`のdocumentation buildを含む全チェックが成功する。
- [ ] Windowsで`pnpm run dev:web --host 127.0.0.1 --port 0`が初回ビルドを完了し、監視プロセスと`dsh web`を起動する。
- [ ] 生成されたWeb成果物は`es2022`ターゲットと現在のminify設定を維持する。
- [ ] macOSとLinuxでは大入力の既存処理を変更しないか、変更する場合は同等の成果物と性能への影響を検証する。
- [ ] 依存関係の再インストール後も修正が適用され、`node_modules`への手作業を必要としない。

## テスト計画

- Windowsで1 MiB未満と1 MiB超の入力を変換する回帰テストを実行する。
- Windowsで`pnpm run build:web`を実行する。
- Windowsで`pnpm run doc-sync`を実行する。
- Windowsで`pnpm run dev:web --host 127.0.0.1 --port 0`を起動し、認証済みURLがHTTP 200と`window.__DSH_BOOT__`を返すことを確認する。
- macOSまたはLinuxで`pnpm run build:web`を実行し、非Windows経路の回帰がないことを確認する。
- パッチを採用する場合は、クリーンな依存関係インストール後に大入力回帰テストを再実行する。

## リスク

IPC経路で大きな入力を渡すと、Windowsのビルド時間とピークメモリ使用量が増える可能性がある。依存パッケージへのパッチはesbuild更新時に競合または不要化するため、対象版を固定し、更新時の再評価が必要になる。Viteのtargetやminifyを無効化する回避策は成果物の互換性とサイズを変えるため採用しない。

## 変更履歴

`CHANGES.md` impact: no

## 注記

Git hookのインストールでも`Access is denied`が観測されたが、Web buildを停止させた直接のエラーは`vite:esbuild-transpile`による一時ファイル削除失敗だった。両者を同じ修正へ含めない。
