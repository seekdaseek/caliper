#!/bin/sh
# Record every symbol the model covers. The set is read from model.json at run time
# so it tracks each 6-hourly refit. Never hand-picked: choosing symbols by outcome
# is exactly the gaming caliper is built to detect.
set -e
cd /opt/caliper
export LIQ_DB=/opt/agentfeed/liquidations.db
export RECORD_DB=/opt/caliper/record.db
export CALIPER_MODEL=/opt/caliper/model.json
export NODE_NO_WARNINGS=1
SYMBOLS=$(/usr/bin/node bin/symbols.cjs)
export SYMBOLS
exec /usr/bin/node bin/record.mjs
