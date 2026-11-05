# Security policy

## Reporting a problem

Please **don't open a public issue** for a security problem. Report it privately instead:

1. Go to the [Security tab](https://github.com/NovaPrime-Actual/SwitchBoard-AV/security) of this repository.
2. Choose **Report a vulnerability**.

Say what you found, which version you ran (the About window shows it), and how to reproduce it. If you can,
say what an attacker could do with it. Please don't test against someone else's installation.

This is a small project maintained by one person, so I can't promise a reply time, but reports are read and
taken seriously. Once a fix is released I'm happy to credit you in the changelog, if you want that.

## What is covered

The latest release. Older versions are not patched; update to the newest one.

SwitchBoard-AV is meant for a trusted network. It controls display equipment, so it is built to be safe to
run (HTTPS on by default, hashed passwords, sessions that expire, security headers, per-person access), but
it is not meant to be put on the open internet. The README's _Security notes_ section describes what it does
and doesn't protect against.
