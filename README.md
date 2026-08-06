# caliper

A miner and an evaluation script for [Telegraph Protocol](https://telegraphprotocol.com), built for Season I.

Two halves of the same idea. The miner answers a forward-looking question about liquidation cascades from a tape nobody else has. The script scores miners against recorded ground truth in a way that is hard to game.

## The question

Will this symbol see more liquidation volume in the next 15 minute window than its own 90th percentile window over the reference period?

It normalises itself across 799 symbols of wildly different size, its base rate is roughly 10 percent by construction, and anyone subscribed to the same public exchange feed can settle it without trusting the miner.

## Why the answers are worth anything

The history is private, the ground truth is public. The model is calibrated on 1.4 million Bybit liquidations across 28 days and 799 symbols, and no exchange publishes liquidation history, so a competitor starting today cannot reconstruct it. But every answer can be checked by anyone recording the same free websocket. Nobody is asked to trust the data.

## The evaluation script

Resistance to gaming has a mathematical answer that most scoring scripts miss. A scoring rule is proper when a forecaster maximises its expected score only by reporting what it actually believes. Brier and log score are proper. Accuracy is not, and accuracy is what most scripts measure.

Four attacks are staged as tests, each shown beating a naive accuracy metric and failing here.

Base rate camping, answering the majority class every time. Beaten by scoring skill against climatology, and by the resolution term of the Murphy decomposition, which is exactly zero for a constant forecaster.

Cherry picking, answering only the easy questions. Beaten by charging every decline the reference score, so selectivity earns nothing unless you are genuinely better.

Copying, mirroring whoever leads. Beaten by measuring whether removing a miner costs the consensus anything. Similarity alone is never the verdict, because two honest miners looking at the same public data should agree.

Confidence inflation. Punished automatically by properness, and made visible by the reliability curve.

## Three states, not two

Every fact carries one of three states. Measured means we asked and got a real answer. Absent means we asked and the world genuinely has none. Unmeasured means our own lookup broke, and it never becomes data. Unmeasured is contagious: anything derived from an unmeasured input is itself unmeasured.

That distinction is enforced in places it would be easy to skip. A symbol that trades but never liquidates is absent. A symbol we have never recorded is unmeasured, because its silence says nothing about the market and everything about our coverage. A window with no liquidations is a quiet market, not missing data.

## The track record

A backtest is a claim about the past that its author also chose how to compute. Everyone has one.

So the miner also keeps a public log: forecasts written down before the window they describe, settled afterwards from the exchange feed, every row published so the score can be recomputed rather than believed. Three rules are enforced by the database rather than by good intentions. A forecast can only be written before its window opens. Only once per symbol and window. An outcome can only be settled once.

## Honest limits

The reported skill is a probability edge, not a trading edge. No costs, no slippage, no exit is modelled.

`SEALED_AT` records the instant after which evaluation data is genuinely unseen. On 6 August 2026 a reliability curve was read over the last quarter of the tape and the model was changed because of what it showed, so every observation that existed at that moment is contaminated and no re-splitting can undo it. The final read evaluates only on windows starting after the seal, and `bin/backtest.mjs --final` refuses to run otherwise.

## Run it

    npm test                                    99 tests, no network, no dependencies
    node bin/fit.mjs                            build model.json from the tape
    node bin/backtest.mjs                       validation slice
    node bin/backtest.mjs --final               sealed slice, refuses if unsealed
    node bin/sweep.mjs                          tune on validation
    node bin/compare.mjs                        settle a change with a paired bootstrap
    node bin/record.mjs                         write the next forecast, settle what closed

`LIQ_DB` points at the liquidation tape. `CONFIG_A` and `CONFIG_B` take `scheme:shrinkage` pairs.

## Live

Served through [AgentFeed](https://x402.ochinimus.app) on Base over x402. `get_cascade_forecast` is paid; `get_cascade_forecast_free`, `get_forecast_question` and `get_forecast_record` are free, because a forecast nobody can check is worth nothing.

## Licence

MIT.
