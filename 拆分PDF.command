#!/bin/bash
# 双击这个文件即可运行（macOS 会自动打开终端窗口）。
# 作用：把大 PDF（教科书等）拆成能上传的小份，可选压缩。
cd "$(dirname "$0")" || exit 1
if [ ! -x .venv/bin/python ]; then
  echo "找不到 Python 环境（.venv）。请先运行一次 ./start.sh 完成安装。"
  read -n 1 -s -r -p "按任意键关闭…"
  exit 1
fi
./.venv/bin/python split_pdf.py
echo
read -n 1 -s -r -p "按任意键关闭这个窗口…"
