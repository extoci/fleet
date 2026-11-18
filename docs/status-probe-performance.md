# Bounded member status probes

`status --check` (human and JSON), `status --watch`, and `doctor` previously
probed every member serially. Each call also reloaded the complete inventory.
They now share eight scoped blocking workers and probe the already-loaded
members. Results are collected by inventory index, not completion order.
Unchecked status still does not probe. Transport selection and the 700 ms
per-member timeout are unchanged. No async runtime or new dependency is needed
for these blocking socket probes.

## Measurements

Ubuntu VM, release binary; Python `perf_counter` around CLI subprocesses, one
warm-up plus five measured runs per cell. Values are mean ± sample standard
deviation in seconds. Both versions ran on the same VM with the same fixture
method. These are small samples, not a claim of statistical significance for
millisecond differences. The after run overlapped Rust test compilation for
the first two offline sizes.

| Offline members | Before | After |
| ---: | ---: | ---: |
| 1 | 0.704366 ± 0.000178 | 0.711524 ± 0.008907 |
| 4 | 2.805475 ± 0.001010 | 0.716093 ± 0.015619 |
| 8 | 5.606192 ± 0.000286 | 0.704266 ± 0.000284 |
| 16 | 11.211406 ± 0.002038 | 1.406562 ± 0.004168 |

| Online members | Before | After |
| ---: | ---: | ---: |
| 1 | 0.003278 ± 0.000259 | 0.002941 ± 0.000142 |
| 4 | 0.005419 ± 0.001388 | 0.004647 ± 0.001336 |
| 8 | 0.008454 ± 0.003177 | 0.006188 ± 0.001053 |
| 16 | 0.015153 ± 0.002961 | 0.007293 ± 0.002080 |

Four offline members, watch refresh interval (four intervals between five
`CAPTAIN` lines): **4.801313 ± 0.000059 s → 2.700869 ± 0.000311 s**.
The existing two-second sleep remains unchanged. All eight before/after human
status outputs were byte-for-byte identical, including inventory order.

## Reproduce

Use a disposable Linux VM with passwordless sudo, Python 3, `iproute2`, and an
SSH listener on `0.0.0.0:22`. The benchmark temporarily modifies `/etc/hosts`
(restored in `finally`) and uses a dummy interface. Do not interrupt it with
SIGKILL. It does not run `fleet init` or join any fleet.

The dummy interface's own address, `192.0.2.1`, is online via the VM's existing
sshd. `192.0.2.2` is on that interface's directly-connected subnet but has no
peer; TCP connections reliably hit Fleet's 700 ms timeout. Hosts aliases avoid
DNS variability. Unlike a silent TCP listener, this exercises the connection
timeout: Fleet's probe only checks TCP connect, not an SSH handshake.

```sh
sudo -n ip link add fleetbench0 type dummy
sudo -n ip addr add 192.0.2.1/24 dev fleetbench0
sudo -n ip link set fleetbench0 up
ss -ltn 'sport = :22'  # require a listener on 0.0.0.0:22

# Before source edits, with the original release binary:
cargo build --release --locked
sudo -n python3 docs/status-probe-benchmark.py "$PWD/target/release/fleet" before /home/ubuntu/fleet-status-benchmark
# After source edits, use the same command and fixture generator:
cargo build --release --locked
sudo -n python3 docs/status-probe-benchmark.py "$PWD/target/release/fleet" after /home/ubuntu/fleet-status-benchmark

sudo -n ip link delete fleetbench0
```

The script takes `BINARY LABEL OUTPUT_DIRECTORY`, writes raw timing samples to
`LABEL.json`, and saves real CLI stdout per case. Each status measurement is
exactly `FLEET_HOME=<fixture> FLEET_AGENTS_HOME=<fixture>/agents BINARY status
--check`; watch uses `BINARY status --watch` with four offline members and is
stopped with SIGINT after the fifth frame. Fixture config and inventories are
generated without changing real Fleet state. For the recorded measurements,
the script lived at `/home/ubuntu/fleet-status-benchmark.py` and used the same
output directory as above; the committed copy only parameterizes that path
and removes unused imports/a listener helper.

Exact recorded benchmark invocations (from `/home/ubuntu/repos/fleet`):

```sh
sudo -n python3 /home/ubuntu/fleet-status-benchmark.py /home/ubuntu/repos/fleet/target/release/fleet before
sudo -n python3 /home/ubuntu/fleet-status-benchmark.py /home/ubuntu/repos/fleet/target/release/fleet after
```

Baseline source revision: `7350c80b2cfc5a99543578cd13e3d54041e45667`.

Quick check on an existing captain:

```sh
cargo run --release -- status --check
```

The concurrency unit test blocks a full wave of eight probes, verifies that
no ninth probe starts before release, and checks mixed reachable/unreachable
results in inventory order after out-of-order completion. Separate coverage
checks empty, all-unreachable, and all-reachable inventories. Real SSH/Tailscale
end-to-end tests remain opt-in/ignored by the existing test suite.
