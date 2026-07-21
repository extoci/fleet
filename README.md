# fleet – make your computers feel like one computer

[watch the video](https://www.youtube.com/watch?v=ZvUwW5hoY80)

---

fleet is a local tool that magically connects your development machines for ai coding.

one machine is the **captain**. the others get real `.local` names, passwordless ssh from the captain, persistent themed tmux sessions, and ai agent integrations. 

fleet also gives agents a skill that tells them which machines exist and how to reach them.

fleet only handles the computers. your coding tools decide what work happens on them.

## installation

install or update to the latest release:

```sh
curl -fsSL https://extoci.lol/fleet | bash
```

the installer downloads the correct binary for macos or linux, verifies its checksum, and puts `fleet` in a writable user directory on your `PATH` when possible.

## usage

on the computer you want to use as the captain:

```sh
fleet init
```

on another computer on the same trusted network:

```sh
fleet join
```

back on the captain:

```sh
fleet status
ssh machine.local
```

that ssh connection opens or reattaches to a tmux session named `fleet`, so closing your laptop does not also close whatever was running on emerald.

the machines get different terminal colors so you can easily tell where you're connected, at a glance.

## commands

run `fleet` without arguments or subcommands to view the full list of commands.

## how it works

fleet is mostly an opinionated setup around things your computers already know how to do:

- mdns gives every machine a name like `emerald.local`
- ssh gives the captain passwordless access to members
- tmux keeps work alive between connections
- shell and tmux colors make it obvious which machine you are using
- a generated fleet skill makes the machine list readable by compatible coding agents

fleet does not proxy normal work after setup. `ssh emerald.local`, scp, sftp, and ordinary remote commands are still just normal ssh.

interactive ssh enters the persistent tmux session by default. bypass it once with:

```sh
ssh -t emerald.local 'NO_TMUX=1 exec "$SHELL" -l'
```

## trust and privacy

fleet has no accounts, hosted control plane, relay, or telemetry. its state and coordination stay on your local network. installing fleet, system packages, codex, or claude code can obviously contact their official download sources.

captain discovery uses unauthenticated mdns. `fleet join` shows you the captain and its fingerprint before trusting it, which is trust-on-first-use for a trusted lan, not magic cryptographic proof that the person next to you is not doing something weird.

after joining, fleet pins machine identities and ssh host keys. registration and leave requests are signed with the pinned fleet identity.

## requirements

- macos or debian/ubuntu linux with systemd and apt
- bash or zsh
- machines on the same trusted local network
- one captain and one fleet per machine

fleet does **not** do tailscale, task orchestration or windows. it just gives tools access to machines, it does not become the tool using them.

## gpt-5.6

fleet was exclusively implemented by gpt-5.6 sol. it would've been impossible without it, due to its extremely impressive computer use capabilities across the network.

fleet was used in the development of fleet.

i wrote more on the [blog post](https://extoci.lol/blog/fleet)

## development

most of the build scripts here are just documentation for my agents. i would recommend you ask your agents to explore the codebase, they'll pick up on everything.
