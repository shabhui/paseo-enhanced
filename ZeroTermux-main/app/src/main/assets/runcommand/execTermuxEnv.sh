#!/system/bin/sh
#################ZeroTermux###########
#    ZeroTermux Shell 启动会话脚本     #
######################################
export PREFIX='/data/data/com.paseoe/files/usr'
export HOME='/data/data/com.paseoe/files/home'
export LD_LIBRARY_PATH='/data/data/com.paseoe/files/usr/lib'
export PATH="/data/data/com.paseoe/files/usr/bin:/data/data/com.paseoe/files/usr/bin/applets:$PATH"
export LANG='en_US.UTF-8'
export SHELL='/data/data/com.paseoe/files/usr/bin/bash'
cd "$HOME"
exec "$SHELL" -l

