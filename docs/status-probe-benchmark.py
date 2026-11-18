import json, os, pathlib, signal, statistics, subprocess, sys, time, uuid

ROOT = pathlib.Path(sys.argv[3])
ROOT.mkdir(exist_ok=True)
BINARY = sys.argv[1]
LABEL = sys.argv[2]
HOSTS = pathlib.Path('/etc/hosts')
original_hosts = HOSTS.read_text()

def machine(name):
    return f'id = "{uuid.uuid4()}"\nname = "{name}"\ncolor = "blue"\nssh_user = "fleet-bench"\nos = "linux"\narch = "x86_64"\ntools = []\npublic_identity = "ssh-ed25519 AAAATEST"\n'

def fixture(n, online):
    home = ROOT / f'{"online" if online else "offline"}-{n}'
    inventory = home / 'inventory'
    inventory.mkdir(parents=True, exist_ok=True)
    (home / 'config.toml').write_text('version = 1\nrole = "captain"\n[machine]\n' + machine('fleet-bench-captain'))
    for old in inventory.glob('*.toml'):
        old.unlink()
    prefix = 'fleet-perf-online' if online else 'fleet-perf-offline'
    for i in range(n):
        (inventory / f'{i}.toml').write_text(machine(f'{prefix}-{i:02}'))
    return dict(os.environ, FLEET_HOME=str(home), FLEET_AGENTS_HOME=str(home / 'agents'))

results = []
try:
    # The interface is created once by the documented setup command.
    HOSTS.write_text(original_hosts + '\n' + '\n'.join(
        f'{ip} ' + ' '.join(f'fleet-perf-{kind}-{i:02}.local' for i in range(16))
        for kind, ip in [('offline', '192.0.2.2'), ('online', '192.0.2.1')]) + '\n')
    # Existing VM sshd listens on 0.0.0.0:22, including this dummy address.
    for online in (False, True):
        for n in (1, 4, 8, 16):
            env = fixture(n, online)
            command = [BINARY, 'status', '--check']
            subprocess.run(command, env=env, check=True, capture_output=True)
            samples = []
            for _ in range(5):
                start = time.perf_counter()
                output = subprocess.check_output(command, env=env, text=True)
                samples.append(time.perf_counter() - start)
            (ROOT / f'{LABEL}-{"online" if online else "offline"}-{n}.txt').write_text(output)
            row = dict(case='online' if online else 'offline', n=n, samples=samples,
                       mean=statistics.mean(samples), stdev=statistics.stdev(samples))
            results.append(row)
            print(f'{row["case"]} {n}: {row["mean"]:.6f} ± {row["stdev"]:.6f} s', flush=True)
    env = fixture(4, False)
    process = subprocess.Popen([BINARY, 'status', '--watch'], env=env, stdout=subprocess.PIPE, text=True)
    stamps = []
    for line in process.stdout:
        if line.strip() == 'CAPTAIN':
            stamps.append(time.perf_counter())
            if len(stamps) == 5:
                process.send_signal(signal.SIGINT)
                break
    process.communicate(timeout=10)
    samples = [b-a for a, b in zip(stamps, stamps[1:])]
    row = dict(case='watch-offline', n=4, samples=samples,
               mean=statistics.mean(samples), stdev=statistics.stdev(samples))
    results.append(row)
    print(f'watch-offline 4: {row["mean"]:.6f} ± {row["stdev"]:.6f} s', flush=True)
    (ROOT / f'{LABEL}.json').write_text(json.dumps(results, indent=2))
finally:
    HOSTS.write_text(original_hosts)
