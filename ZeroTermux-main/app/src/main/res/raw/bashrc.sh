#!/system/bin/sh
#################ZeroTermux###########
#    ZeroTermux Shell 增加会话脚本     #
######################################
pid=$$
shell_ZeroTermux() {
echo ">>>>>>>>>>>>>>>>>shell_ZeroTermux"
export PREFIX='/data/data/com.paseoe/files/usr'
export HOME='/data/data/com.paseoe/files/home'
export LD_LIBRARY_PATH='/data/data/com.paseoe/files/usr/lib'
export PATH="/data/data/com.paseoe/files/usr/bin:/data/data/com.paseoe/files/usr/bin/applets:$PATH"
export LANG='en_US.UTF-8'
export SHELL='/data/data/com.paseoe/files/usr/bin/bash'
cd "$HOME"
# 不要用 exec / login shell：会卡住 LibSu 或替换进程，导致定时任务无法结束
"$SHELL" "./.timerdir/termux_timer.sh"
}
shell_Android() {
echo ">>>>>>>>>>>>>>>>>shell_Android"
chmod 777 /data/data/com.paseoe/files/home/.timerdir/shell_timer.sh
./data/data/com.paseoe/files/home/.timerdir/shell_timer.sh
}

shell_kill() {
echo ">>>>>>>>>>>>>>>>>shell_kill"
kill -9 pid
}
shell_chmod() {
    chmod 777 /data/data/com.paseoe/files/execTermuxEnv.sh
}
