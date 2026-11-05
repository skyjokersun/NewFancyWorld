# Security Policy

Please avoid posting passwords, registration codes, private keys or player records in public issues.

- Protect port `19810`; the admin dashboard is HTTP and should not be directly exposed to the internet.
- Use `QIYU_DEV=0` on shared/public servers.
- Registration fallback without SMTP does not verify the user's email ownership.
- Back up `var/state.json` locally; never commit it.
- `CN=SSS` in the downloadable Windows EXE is only a self-signed publisher label.

For security concerns, contact the repository maintainer privately through their GitHub profile rather than publishing exploit details.
