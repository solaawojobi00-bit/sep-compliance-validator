# Security Policy

## Reporting a vulnerability

**Report privately through GitHub, not in a public issue.**

Go to the [Security tab](https://github.com/solaawojobi00-bit/sep-compliance-validator/security/advisories/new)
and choose **Report a vulnerability**. The report is visible only to you and the
maintainers until an advisory is published, so there is no address to publish, scrape,
or keep monitored.

If you have already opened a public issue before reading this, say so in the private
report and we will handle the disclosure from there rather than asking you to delete it.

Please include, as far as you can:

- What an attacker gains, not only what misbehaves.
- The version or commit you tested, and the command line you ran.
- Reproduction steps. A failing invocation against a throwaway anchor is worth more than
  a description.
- Whether exploiting it requires `--i-understand-this-touches-production`,
  `--interactive-browser`, or `--sep12-verification-code`, since those change who is
  exposed.

## What is in scope

This tool is a validator: its ordinary, intended behaviour is to send deliberately
malformed and hostile requests to third-party servers. That makes the scope boundary
unusually important, so it is stated plainly here.

**In scope — vulnerabilities in this project:**

- Leakage of `--sep12-verification-code`. The README commits to this value never
  reaching the report, the console, or a CI log. A path that breaks that promise is a
  vulnerability, not a defect.
- Leakage of SEP-10 authentication material — challenge transactions, signatures, or
  JWTs — into reports, logs, artifacts, or error output.
- Failure of SEP-12 teardown, or synthetic-identity generation that collides with real
  customer data. The validator issues state-mutating `PUT /customer` and `DELETE`
  requests against live anchors; a flaw here touches data that is not ours.
- Anything letting anchor-controlled content reach beyond the checker: command
  injection from a `stellar.toml` value, path traversal from a server-supplied
  filename, or escape from the Playwright browser started by `--interactive-browser`,
  which by definition loads untrusted pages.
- Compromise of the published GitHub Action. `action.yml` means anchor repositories
  execute this code inside their own CI, so a supply-chain flaw here reaches downstream
  pipelines.
- Guardrail bypass — anything that performs a mainnet write without
  `--i-understand-this-touches-production`.

**Out of scope — findings about anchors this tool scans:**

If the validator reports that some anchor's SEP-10 implementation accepts an unsigned
challenge, that is a finding **about that anchor**, and it belongs to that anchor's
operator. Please report it to them, not here. This project has no relationship with the
servers it is pointed at and cannot fix, coordinate, or embargo their issues.

The exception is when the validator is *wrong* — reporting a pass where the anchor is
genuinely vulnerable. A check that silently misses a real flaw gives operators false
assurance, and that is a vulnerability in this project. Report it here.

Also out of scope: vulnerabilities in dependencies with no exploitable path through this
code (report those upstream), and results from scanning anchors you do not operate or
have permission to test.

## Supported versions

| Version | Supported |
| --- | --- |
| Latest release | Yes |
| Older releases | No |

The project is pre-1.0 and ships no long-term support branches. Fixes land on `main` and
go out in the next release; there are no backports. Pin a version if you need
reproducibility, but track releases if you need fixes.

## What to expect

- **Acknowledgement within 5 business days.** If you have not heard back by then, assume
  the report was missed rather than ignored, and open a public issue saying only that you
  are awaiting a response on a private report — with no detail.
- **An assessment within 10 business days**, saying whether we consider it a
  vulnerability, and if so how severe and roughly when a fix will land.
- **Coordinated disclosure.** We will agree a date with you rather than publishing
  unilaterally, and will credit you in the advisory unless you ask us not to.

We will not take legal action against anyone who reports in good faith, follows this
policy, and gives us a reasonable chance to fix the issue before disclosing it.
