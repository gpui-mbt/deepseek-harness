# esbuild Windows 输入传输

[English](README.md) | 中文

esbuild 补丁让 Windows 上的大型转换输入沿用现有 IPC 路径，因为受限的原生子进程无法删除输入临时文件。macOS 和 Linux 保留上游的文件传输方式；构建目标和代码压缩选项不变。原生输出文件的处理方式不变：由 Node 读取并删除这些文件。

固定版本为 0.21.5（VitePress/Vite 5）、0.25.12（Web/Vite 6）和 0.28.1/0.28.2（构建工具）。2026-10-22 的 NPM 注册表检查确认，0.21.5 和 0.25.12 已是各自兼容次版本范围内的最新版本。最新发布版 0.28.2 仍保留相同的输入文件优化，未打补丁时，四个版本的 Windows 传输回归测试均失败。

上游实现：[共享转换传输](https://github.com/evanw/esbuild/blob/v0.28.2/lib/shared/common.ts)和 [Node 文件系统传输](https://github.com/evanw/esbuild/blob/v0.28.2/lib/npm/node.ts)。每次更改确切依赖版本时，重新评估相应补丁的必要性。对于大型输入，IPC 可能增加 Windows 的峰值内存占用和传输时间。

运行 `pnpm install --frozen-lockfile`，再运行 `pnpm run test:esbuild-tempfile`，即可验证重新安装。测试覆盖字符串、字节数组和多字节输入、异步与同步 API、恰好 1 MiB 及其两侧，以及更大的输入。原生探针使用宿主操作系统；模拟平台探针保留宿主二进制文件，仅选择传输分支，不能据此确认原生 Windows 的权限行为。专用 CI 工作流还会执行原生 Windows、macOS 和 Linux 构建，以及开发服务器冒烟测试。
