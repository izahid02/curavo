# Putting the Curavo cloud + website on the server

`setup.sh` installs (or updates) everything on an Ubuntu 24.04 server:
the cloud server as a service, Curavo Control, the website for curavo.in,
HTTPS for both (Caddy), a swap file and automatic security updates.  Safe to
run again: data and the panel password are kept.

Build the package (Claude does this): a folder `curavo-cloud-deploy/` with
`setup.sh`, `cloud/server`, `cloud/admin/dist` and `website/`, packed as
`curavo-cloud-deploy.tgz`.

On the Mac:

    KEY=~/Projects/ARZ-licence-keys/curavo-cloud-key.pem
    scp -i $KEY ~/Projects/curavo-cloud-deploy.tgz ubuntu@52.64.125.90:~
    ssh -i $KEY ubuntu@52.64.125.90 "rm -rf curavo-cloud-deploy && tar xzf curavo-cloud-deploy.tgz && sudo bash curavo-cloud-deploy/setup.sh"

The cloud's online licence key (issues keys for paid accounts) goes up
separately, once - setup.sh moves it into place and deletes the copy:

    scp -i $KEY ~/Projects/ARZ-licence-keys/arz_online_licence_private.pem ubuntu@52.64.125.90:~/online_licence_key.pem

Never put the MASTER licence key or the backup recovery key on the server.
