# 复制为 run-daily.local.sh 后，填入 config.json 中的真实账号名。
# run-daily.local.sh 被 Git 忽略，部署时需单独同步到 runtime。
PRIMARY_ACCOUNT="account1"
SECONDARY_ACCOUNT="account2"
TERTIARY_ACCOUNT="account3"

# 次日 07:00 的验证码流程起点：02.000 / 02.300 / 02.600。
PRIMARY_START_OFFSET_MS=2000
SECONDARY_START_OFFSET_MS=2300
TERTIARY_START_OFFSET_MS=2600

# launchd 不读取交互式 shell 配置；使用 nvm 时设置实际 Node bin 目录。
# NODE_BIN_DIR="$HOME/.nvm/versions/node/v22.23.2/bin"
