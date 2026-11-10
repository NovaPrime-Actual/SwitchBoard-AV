# Running SwitchBoard-AV with Docker

Each release is published as a container image on the GitHub Container Registry, for Linux on Intel/AMD
and ARM (such as a Raspberry Pi):

```
ghcr.io/novaprime-actual/switchboard-av
```

Tags: `latest` is the newest release, and a version such as `2.15` stays on that release. The image is built
by [`.github/workflows/docker.yml`](.github/workflows/docker.yml) when a release is published, from the
[`Dockerfile`](Dockerfile) in this folder. For everything the app itself does, see the [README](README.md).

## With `docker run`

```
docker run -d --name switchboard-av --hostname switchboard-av --restart unless-stopped \
  -p 8080:8080 -v switchboard-data:/data \
  -e TLS_HOSTS=av.example.org \
  ghcr.io/novaprime-actual/switchboard-av:latest
```

Then open `https://<server address>:8080`. The browser warns about the self-signed certificate on the first
visit (see **HTTPS** in the README).

## With Docker Compose

Save this as `compose.yaml` next to where you want to run it, then `docker compose up -d`:

```yaml
services:
  switchboard-av:
    image: ghcr.io/novaprime-actual/switchboard-av:latest # or a version, such as :2.15
    container_name: switchboard-av
    hostname: switchboard-av # keep it fixed: see "Certificate names" below
    restart: unless-stopped
    ports:
      - "8080:8080"
    volumes:
      - switchboard-data:/data # everything the app saves
    environment:
      TLS_HOSTS: av.example.org # the name or address people type, comma separated
      # STATUS_POLL_SECONDS: "20" # any other setting from the README's table goes here too

volumes:
  switchboard-data:
```

To update: `docker compose pull`, then `docker compose up -d`. The data stays in the volume.

To build from a copy of this repository instead of pulling the image, replace the `image:` line with
`build: .`.

## First sign-in

The temporary admin password is printed once, in the container's log:

```
docker logs switchboard-av
```

You are asked to choose a new password when you first sign in.

## Things to know

- **Keep the data.** Everything the app saves lives in `/data`: accounts, groups, the device list, activity
  and the self-signed certificate. Mount a volume or a folder there, as above, or it is lost when the
  container is removed. The app's own **Backup** tab (Users, then Backup) works inside the container as usual,
  and a download from it is the easiest way to keep a copy off the server.
- **Certificate names.** Inside a container the app only knows the container's own name and address, so set
  `TLS_HOSTS` to the name or address people type. Keep `hostname` fixed as above: without it Docker gives
  every new container a random name, and the app makes a new self-signed certificate (and browsers warn
  again) each time you update.
- **Reaching the screens.** The app talks to the decoders over the network, so the container must be able to
  reach them. A normal Docker network works for that. If your network needs the container to be on it
  directly, use `network_mode: host` (Linux only) in Compose, or `--network host` with `docker run`, and drop
  the `ports` / `-p` part.
- **Another port.** Change the left number: `-p 443:8080` or `"443:8080"` serves on 443 and leaves the
  app's own port alone. The `PORT` variable is not needed.
- **Behind a reverse proxy.** Add `TRUST_PROXY: "1"` (or `-e TRUST_PROXY=1`) and the app serves plain HTTP
  for the proxy to encrypt. See **Turning it off, or using a proxy** in the README.
- **Other settings.** Every variable in the README's table is passed the same way, with `environment:` in
  Compose or `-e` with `docker run`. `DATA_DIR` is already set to `/data`, and the app runs as the
  unprivileged `node` user.
- **Health check.** The image asks the app's front page whether it is up. `docker ps` shows `healthy` once it
  is.
