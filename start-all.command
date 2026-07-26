#!/bin/zsh

ROOT=${0:A:h}
"$ROOT/start-all.sh"
status=$?

echo
if [[ $status -eq 0 ]]; then
  echo "全部服务已就绪，可以关闭此窗口。"
else
  echo "启动失败，请查看上方信息。"
fi
read -k 1 "?按任意键关闭…"
echo
exit $status
