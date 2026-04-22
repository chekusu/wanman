# Local sandbox (BoxLite)

By default `wanman takeover` runs agent subprocesses directly on your host, isolated only by a per-agent worktree and a per-agent `$HOME`. If you want stronger isolation — a misbehaving agent that types `rm -rf $HOME` should bounce off a boundary, not your actual home directory — run the matrix inside a [BoxLite](https://www.npmjs.com/package/@sandbank.dev/boxlite) microVM.

## What BoxLite is

BoxLite is Sandbank's local microVM runtime. Same shape as Firecracker/QEMU-backed sandboxes — you hand it an OCI image and a bundle, and it boots a short-lived VM you can exec commands in. wanman ships a BoxLite adapter in `@wanman/cli` that drops the whole supervisor + agents into one VM, then proxies JSON-RPC back to your host CLI.

From the agent's point of view nothing changes — `wanman send`, `wanman recv`, `wanman task` all work exactly the same. The difference is that a filesystem escape stays inside the VM.

## Install BoxLite

BoxLite is distributed as a Python package. The usual install flow is a dedicated virtualenv so it doesn't collide with your system Python:

```bash
python3 -m venv /tmp/boxlite-venv
/tmp/boxlite-venv/bin/pip install --upgrade pip
/tmp/boxlite-venv/bin/pip install boxlite
```

> Verify the package name and install instructions against the upstream [BoxLite docs](https://www.npmjs.com/package/@sandbank.dev/boxlite) for your platform — the exact wheel availability evolves. The command above is the shape wanman's own E2E tests use; if it fails, fall back to `/tmp/boxlite-venv/bin/pip install -U boxlite` and check BoxLite's README for platform-specific notes.

On first use BoxLite will download or build its default OCI image into `~/.boxlite/`. This can take a minute or two.

### Linux notes

BoxLite benefits from KVM. On most Linux distros you need to be in the `kvm` group:

```bash
sudo usermod -aG kvm $USER
# Log out and back in.
ls -l /dev/kvm     # crw-rw---- 1 root kvm
```

Without KVM, BoxLite falls back to slower software virtualization — still correct, just slower to boot.

### macOS notes

BoxLite uses the Virtualization.framework backend on Apple Silicon. No extra setup beyond the venv install, but the first boot of a VM may ask for accessibility/virtualization permission.

## Point wanman at BoxLite

Export the Python interpreter path before running wanman. The adapter picks it up automatically:

```bash
export BOXLITE_PYTHON=/tmp/boxlite-venv/bin/python3
wanman run "draft a CHANGELOG from the last 10 commits"
```

Environment variables the adapter honors:

| Variable | Meaning | Default |
|----------|---------|---------|
| `BOXLITE_PYTHON` | Absolute path to the Python interpreter inside your BoxLite venv. **Required** to enable the adapter. | unset (host mode) |
| `BOXLITE_HOME` | BoxLite state dir (OCI cache, VM scratch). | `~/.boxlite` |
| `BOXLITE_PREFIX` | Prefix applied to VM names — useful when multiple wanman instances share the same host. | `wanman` |
| `BOXLITE_API_URL` | Point at a remote BoxLite server instead of the local daemon. | unset (local) |
| `BOXLITE_API_TOKEN` | Bearer token for the remote API. | unset |
| `BOXLITE_CLIENT_ID` / `BOXLITE_CLIENT_SECRET` | OAuth-style credentials for remote BoxLite. | unset |

The older `SANDBANK_URL` and `SANDBANK_API_KEY` names are accepted as aliases of `BOXLITE_API_URL` and `BOXLITE_API_TOKEN`.

## Verify it works

```bash
export BOXLITE_PYTHON=/tmp/boxlite-venv/bin/python3
wanman run "hello"
```

You should see log lines about the BoxLite VM booting, the supervisor coming up inside the VM, and then normal agent activity. `wanman watch` in another terminal will stream the same events — the CLI does not care whether the supervisor runs on the host or inside a VM.

Drop back to host mode any time by clearing the env var:

```bash
unset BOXLITE_PYTHON
wanman run "hello"
```

## Troubleshooting

- **`BOXLITE_PYTHON ... not found` / adapter silently skipped.** Check the path points at the venv's `bin/python3`, not the venv root. Make sure the venv is activated-enough for the binary to exist: `ls -l $BOXLITE_PYTHON`.
- **Permission denied on `/dev/kvm` (Linux).** Add yourself to the `kvm` group and re-log. Without that, BoxLite still works but is noticeably slower.
- **First boot hangs "pulling image"**. The default OCI image is being fetched into `$BOXLITE_HOME`. Check `~/.boxlite/` disk usage and give it a few minutes on first run.
- **`wanman send` times out with BoxLite.** The VM's supervisor hasn't finished health checks yet. Run `wanman watch` in another shell — you'll see the boot sequence.
- **Remote BoxLite server rejects auth.** Double-check `BOXLITE_API_URL` and `BOXLITE_API_TOKEN` (or `BOXLITE_CLIENT_ID`/`BOXLITE_CLIENT_SECRET`). The adapter reads them directly from `process.env` at run time.

## See also

- [Quickstart](quickstart.md) — the host-mode first-run.
- [Architecture](architecture.md) — where the adapter sits in the overall data flow.
