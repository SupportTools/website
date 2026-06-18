---
title: "AI Is No Longer Optional for Modern Infrastructure Teams"
date: 2032-04-27T09:00:00-05:00
draft: false
tags: ["AI", "DevOps", "SRE", "Platform Engineering", "Kubernetes", "Terraform", "Incident Response", "Automation", "Engineering Culture", "Toil Reduction", "Runbooks", "Governance"]
categories:
- DevOps
- Engineering Culture
- AI
author: "Matthew Mattox - mmattox@support.tools"
description: "AI-assisted workflows have quietly become table stakes for infrastructure, DevOps, and SRE teams. Here is where they genuinely help, where they do not, and how to adopt them responsibly without surrendering judgment."
more_link: "yes"
url: "/ai-no-longer-optional-modern-infrastructure-teams/"
---

A few years ago, AI assistance in operations work was a curiosity. Someone on the team had a paid coding assistant, used it for boilerplate, and occasionally pasted a clever one-liner into Slack. It was a personal productivity hack, not a team practice. That era is over. For infrastructure, DevOps, and SRE teams, AI-assisted workflows have crossed the line from optional advantage to baseline expectation. The teams shipping platform features, closing incidents, and reducing toil at a competitive pace are, almost without exception, using these tools deliberately. The teams that are not are increasingly the ones explaining why everything takes longer.

This is not a hype post. AI does not write flawless Terraform, it does not understand your blast radius, and it will confidently hand you a `kubectl` command that deletes the wrong namespace. The argument here is narrower and more durable: the productivity gap between teams who have integrated AI into their workflows and teams who have not has widened to the point where ignoring it is now a strategic decision, not a neutral default. The interesting question is no longer *whether* to adopt, but *how* to adopt without surrendering the judgment that makes an ops team trustworthy.

<!--more-->

## The Gap Is Organizational, Not Individual

The previous generation of this conversation framed AI as a personal tool. An engineer who used it well got more done. That framing is now incomplete, because the gains compound at the team level in ways they do not at the individual level.

Consider two platform teams of equal size and seniority. Team A treats AI assistance as ambient infrastructure: it is in the editor, in the terminal, in the review process, and in the incident channel. Team B leaves it to individual preference, so adoption is uneven and the workflows around it are improvised. Within a quarter, the difference is not that Team A's engineers type faster. It is that Team A has:

- A larger fraction of its backlog that is "worth starting," because the activation cost of unfamiliar work dropped.
- More consistent first drafts of Helm charts, Terraform modules, and CI pipelines, because everyone starts from a generated scaffold rather than a blank file.
- Faster incident triage, because someone in the channel can summarize a 4,000-line log dump into a hypothesis in seconds.
- Less tribal knowledge locked in one person's head, because runbooks and postmortems get written instead of deferred.

None of those are individual wins. They are throughput changes for the whole team. And throughput is the currency that platform and SRE teams are measured in, whether the metric is lead time for changes, mean time to recovery, or simply how many internal teams they can support without growing headcount.

The competitive pressure is real and it shows up in mundane ways. When a sister team standardizes a new service onto your platform in two days instead of two weeks, "our process is more careful" stops being a satisfying explanation. The bar for what counts as a reasonable timeline has moved, and it moved because the tooling moved.

### The Compounding Effect of Uneven Adoption

There is a second-order problem with leaving adoption to individual preference, and it is more corrosive than slow throughput. When some engineers on a team lean heavily on AI assistance and others avoid it entirely, the team stops sharing a common working method. Reviews become harder to calibrate, because the reviewer cannot tell whether a 600-line PR represents an afternoon of careful thought or a generated draft that was skimmed once. Estimates drift, because two engineers given the same ticket now operate at genuinely different speeds for reasons unrelated to skill. Knowledge fragments, because the engineer who generated a Terraform module from a prompt may understand it less deeply than the one who hand-wrote a smaller one, and the team has no shared expectation about which is which.

This is why "let people use what they like" is a worse policy than it sounds. It is not neutral. It produces a team whose internal consistency erodes precisely as the tools get more capable. The teams pulling ahead are not the ones with the loosest policy or the strictest; they are the ones with an explicit, shared answer to "how do we use this here," so that a generated artifact and a hand-authored one go through the same gates and carry the same accountability.

### What "Necessity" Actually Means Here

The word *necessity* in the title deserves a precise reading, because it is easy to overstate. AI assistance is not necessary in the sense that a team cannot function without it; teams shipped excellent infrastructure for decades before any of this existed. It is necessary in the narrower, harder-to-escape sense that the surrounding ecosystem now assumes it. The internal customers your platform team supports have their own AI-accelerated workflows and their own compressed expectations. The vendors you integrate with ship faster. The job market for the engineers you want to hire increasingly treats fluency with these tools as ordinary. A team can opt out of any single tool, but opting out of the entire shift means absorbing a steadily growing tax on every interaction with a world that did not opt out. That is what makes it a strategic decision rather than a preference.

## Where AI Genuinely Earns Its Place in Operations

It helps to be specific about where the gains are real, because the marketing flattens everything into "AI makes you 10x faster," which is both untrue and unhelpful. In day-to-day infrastructure work, the value concentrates in a handful of categories.

### Toil Reduction and Glue Code

The single highest-return use is the work that is necessary, repetitive, and slightly different every time. Writing a Bash script to rotate a set of credentials and validate them. Converting a pile of `kubectl` commands into a reproducible manifest. Translating a JSON payload into a Go struct. Generating the forty lines of YAML for a `ServiceMonitor` that you write four times a year and never quite remember the schema for.

This is the work that does not require deep thought but does require fiddly syntax recall, and it is exactly where a good first draft saves the most time. The engineer still reads every line, but reading and correcting is faster than authoring from zero.

```bash
#!/usr/bin/env bash
# Generated scaffold, then reviewed and hardened by hand.
# The AI produced the structure; the set -euo pipefail, the
# trap, and the explicit error messages are where human review matters.
set -euo pipefail

NAMESPACE="${1:?usage: rotate-secret.sh <namespace> <secret-name>}"
SECRET="${2:?usage: rotate-secret.sh <namespace> <secret-name>}"

cleanup() {
  echo "cleaning up temporary files" >&2
  rm -f /tmp/new-secret.$$
}
trap cleanup EXIT

if ! kubectl -n "$NAMESPACE" get secret "$SECRET" >/dev/null 2>&1; then
  echo "secret $SECRET not found in namespace $NAMESPACE" >&2
  exit 1
fi

openssl rand -base64 32 > "/tmp/new-secret.$$"
kubectl -n "$NAMESPACE" create secret generic "$SECRET" \
  --from-file=token="/tmp/new-secret.$$" \
  --dry-run=client -o yaml | kubectl apply -f -

echo "rotated $SECRET in $NAMESPACE"
```

The point of the example is not the script. It is that the AI gave the author a structurally complete starting point in seconds, and the parts that actually matter for safety, the `set -euo pipefail`, the `trap`, the existence check, the `--dry-run` before apply, are the parts a competent engineer adds and verifies on review. The tool collapsed the boring 80 percent so the human could concentrate on the dangerous 20 percent.

### Infrastructure-as-Code Scaffolding

Terraform modules, Helm charts, Kustomize overlays, and CI workflow files all share a property: they are verbose, schema-heavy, and mostly boilerplate around a small core of real decisions. Generating the boilerplate and then editing the decisions is a natural fit.

The critical discipline is that scaffolding is a starting point, never an endpoint. A generated Terraform module will happily invent a resource argument that does not exist, reference a provider version that is not pinned, or omit the lifecycle rules that prevent a destructive plan. The workflow that works is: generate, read, run `terraform validate` and `terraform plan`, and treat the plan output as the source of truth rather than the generated code.

```hcl
# Generated module skeleton. The real work is verifying that every
# argument exists in the provider schema and that the plan is non-destructive.
module "vpc" {
  source  = "terraform-aws-modules/vpc/aws"
  version = "~> 5.0"

  name = var.vpc_name
  cidr = var.cidr_block

  azs             = var.availability_zones
  private_subnets = var.private_subnets
  public_subnets  = var.public_subnets

  enable_nat_gateway = true
  single_nat_gateway = var.environment != "prd"

  tags = var.tags
}
```

A generated block like this is useful precisely because it is unremarkable. It encodes the conventional shape of a VPC module, leaving you to fill in the variables and, more importantly, to decide whether `single_nat_gateway` should really flip on environment, whether the version constraint is tight enough, and whether the subnets line up with your IP plan. The judgment stays with you. The typing does not.

### Runbooks and Postmortems

Documentation is the work everyone agrees is valuable and nobody wants to do. AI changes the economics here more than almost anywhere else, because the raw material already exists. After an incident, the timeline is in the chat history, the metrics are in the dashboards, and the fix is in the merged PR. Turning that into a coherent runbook entry or a structured postmortem is a transformation task, and transformation is what these tools do best.

A useful pattern: paste the incident channel transcript and the relevant graphs description into the assistant and ask it to draft a postmortem in your team's template. What comes back is not the final document. It is a structured draft that gets the timeline, the contributing factors, and the action items into the right shape, which a human then corrects for accuracy and accountability. The blank-page tax disappears, and runbooks that would have been deferred indefinitely actually get written. Over a year, that is the difference between a team with a living knowledge base and a team that re-learns the same outage every time the original responder is on vacation.

### Incident Triage

During an active incident, the constraint is attention, not typing. AI helps in narrow, supervised ways: summarizing a flood of logs into candidate hypotheses, explaining an unfamiliar error message from a dependency you do not own, or recalling the exact flag for a tool you use twice a year. It is a faster reference and a first-pass log reader, not a decision-maker.

The pattern that holds up under pressure is to keep the AI on the *read* side of the incident and the human on the *write* side. A useful starting point is a bounded, read-only collection script that gathers the context a responder would otherwise assemble by hand, so the assistant has something concrete to summarize rather than a vague description of the symptom.

```bash
#!/usr/bin/env bash
# Bounded, read-only triage helper. It never mutates cluster state.
# The output is what you hand to an assistant for summarization, or read yourself.
set -euo pipefail

NAMESPACE="${1:?usage: triage.sh <namespace> [since]}"
SINCE="${2:-15m}"

echo "== recent warning events in $NAMESPACE =="
kubectl -n "$NAMESPACE" get events \
  --field-selector type=Warning \
  --sort-by=.lastTimestamp 2>/dev/null | tail -n 20 || true

echo "== not-ready pods =="
kubectl -n "$NAMESPACE" get pods \
  --field-selector status.phase!=Running 2>/dev/null || true

echo "== last $SINCE of logs from crashlooping pods =="
for pod in $(kubectl -n "$NAMESPACE" get pods \
    -o jsonpath='{range .items[?(@.status.containerStatuses[0].restartCount>0)]}{.metadata.name}{"\n"}{end}' 2>/dev/null); do
  echo "--- $pod ---"
  kubectl -n "$NAMESPACE" logs "$pod" --since="$SINCE" --tail=50 2>/dev/null || true
done
```

The script is deliberately incapable of doing damage; every command reads, none mutate. That property is the point. A responder runs it, the output is verbose and noisy, and *that* is where summarization earns its keep: turning a few hundred lines of events and logs into "three pods are OOMKilled, the memory limit was lowered in the last deploy, and the rollout started eight minutes before the first alert." The hypothesis is generated in seconds; the decision about whether to roll back, raise the limit, or look further stays with the human who understands the blast radius.

The boundary matters enormously here. Using AI to *summarize* a log stream and suggest where to look is sound. Using AI to *execute* remediation against production without a human reading and approving each command is how you turn a small incident into a large one. Triage assistance accelerates the human's understanding; it does not replace the human's authority to act. The same logic extends to the monitoring artifacts that catch the next incident: a generated `ServiceMonitor` is a fine scaffold, but a human confirms the selector and port actually match the running Service before it merges, because a monitor that silently selects nothing is worse than no monitor at all.

```yaml
# Generated ServiceMonitor scaffold. Reviewer confirms the selector and
# port name actually match the Service before merge.
apiVersion: monitoring.coreos.com/v1
kind: ServiceMonitor
metadata:
  name: payments-api
  namespace: monitoring
  labels:
    release: kube-prometheus-stack
spec:
  selector:
    matchLabels:
      app.kubernetes.io/name: payments-api
  endpoints:
    - port: http-metrics
      interval: 30s
      path: /metrics
```

## The Limits Are Real and Worth Naming

Adopting AI responsibly starts with being honest about what it cannot do, because the failure modes in operations are expensive.

**It does not understand blast radius.** An AI will suggest a command that is correct in isolation and catastrophic in context. It does not know that the namespace you are about to drain hosts the cluster's ingress controller, or that the database you are about to migrate is the one without a tested restore. Consequence-awareness is entirely on the human.

**It produces confident, plausible errors.** The dangerous output is not the one that is obviously wrong. It is the Terraform argument that looks real, the PromQL that returns *a* number rather than the *right* number, the `iptables` rule that is subtly too permissive. Plausibility is not correctness, and review has to be calibrated to catch the convincing mistakes, not just the obvious ones.

**It amplifies whatever you bring to it.** This is the most important limit. AI is leverage, and leverage multiplies the input. A team with strong fundamentals, good review culture, and clear standards gets a force multiplier. A team that is shaky on Kubernetes networking and lax on review gets faster production of plausible-looking mistakes. The tool does not supply the judgment; it presumes it. This is why "just give everyone an assistant" is not an adoption strategy.

**It does not absolve accountability.** When a generated change breaks production, "the AI wrote it" is not an explanation any more than "the autocomplete wrote it." The engineer who merged it owns it. That has to be culturally explicit before adoption scales, or the diffusion of responsibility becomes its own outage.

## Failure Modes Specific to Teams

The individual failure modes above are well known. The team-level ones are quieter and do more damage over time, because they degrade the system rather than producing a single visible mistake.

**Review fatigue and rubber-stamping.** When AI lets engineers produce larger diffs faster, the volume of code arriving at review goes up, but the number of reviewer-hours does not. The predictable result is shallower review: reviewers skim, approve on trust, and the verification step that the whole responsible-adoption story depends on quietly hollows out. The fix is not "review harder," which does not scale; it is to keep diffs small, to make generated changes easy to identify so reviewers know where to spend attention, and to lean on automated gates (plan output, policy checks, tests) for the mechanical parts so human review can focus on judgment.

**Skill atrophy at the junior level.** If a junior engineer's first instinct for every task is to generate a solution, they may ship working changes for a year without building the mental model that lets them catch the AI's subtle mistakes. The senior who can spot a wrong `NetworkPolicy` selector built that ability by writing many of them by hand. A team that wants to keep producing seniors has to be deliberate about ensuring people still develop fundamentals, rather than assuming the tool will carry everyone indefinitely.

**Homogenized, mediocre solutions.** Generated infrastructure code tends toward the statistical center of what exists publicly: conventional, plausible, and rarely tuned to your specific constraints. For most boilerplate that is exactly what you want. But a team that uncritically accepts the generated default for everything ends up with infrastructure that is generically reasonable and specifically wrong in the places where your environment is unusual, the gnarly networking, the compliance boundary, the cost trade-off the public examples never had to make.

**Diffusion of responsibility.** When "the AI suggested it" becomes an accepted half-explanation in postmortems, accountability blurs across the whole team. Nobody fully owns a generated change, so nobody scrutinizes it the way they would scrutinize their own. This has to be culturally foreclosed early: the human who merges owns the change, full stop, the same as they always have.

## Measuring Whether It Actually Helps

A claim that AI is now necessary is only honest if you are willing to check whether it is helping your team specifically. Adoption decided by vibes tends to overstate the wins and ignore the costs. The good news is that infrastructure teams already track the metrics that matter, so the measurement does not require new instrumentation, only the discipline to look.

The DORA metrics are the natural frame. If AI assistance is genuinely reducing toil, you should see lead time for changes trend down without change failure rate trending up. That second clause is the whole game: faster delivery that comes with more failed changes or longer recovery is not a win, it is risk being traded for the appearance of speed. Watch the pair, not either alone.

- **Lead time for changes** should fall as scaffolding and glue work get faster.
- **Change failure rate** must stay flat or improve; a rise signals that verification is being skipped.
- **Mean time to recovery** is a fair proxy for whether triage assistance is actually helping during incidents.
- **Review latency and PR size** are early warning signs; if PRs balloon and review time per line collapses, rubber-stamping is setting in.

Beyond the dashboards, the most useful signal is qualitative and comes from retrospectives: ask the team directly where AI saved real time this sprint and where it cost time through misleading output that had to be unwound. Teams are usually honest about this when asked specifically, and the answer tells you where to widen the leash and where to tighten it. The goal is not maximal usage; it is a defensible match between where the tool helps and where you let it run.

## How to Adopt Responsibly

The teams getting durable value from AI are not the ones using it the most. They are the ones using it inside guardrails that preserve verification and accountability. A few principles hold up across environments.

### Treat AI Output as an Untrusted First Draft

The single most important cultural shift is to internalize that AI output has the same trust level as a snippet copied from a random forum post: potentially useful, definitely unverified. Everything it produces goes through the same review as human-authored code. Nothing gets a pass because the machine wrote it. In practice this means generated infrastructure code is never merged without a `plan`, a `diff`, or a dry run that a human reads.

### Keep a Human in the Loop for Anything Stateful

Read-only and generative tasks can run with a loose leash. Anything that mutates state, applies to a cluster, modifies a database, changes a firewall, needs a human approving the specific action. The right mental model is that AI drafts and explains; humans decide and apply. Encode this in tooling where you can, so the easy path is also the safe path.

### Verify Against Authoritative Sources, Not the Model

When the AI claims a flag exists, a resource argument is valid, or an API behaves a certain way, the verification is the documentation, the schema, the `--help` output, or the actual behavior in a test environment, not a second question to the model. Models are excellent at generating and transforming and unreliable as a source of ground truth. Build the habit of confirming claims against the system itself.

### Establish Shared Standards, Not Individual Free-for-Alls

Because gains compound at the team level, the practices should too. Agree on which tasks are appropriate for AI assistance, what the review expectations are, how generated code is labeled or noted, and what data is permitted to leave your environment. Uneven, undocumented adoption produces uneven, undocumented risk.

### Encode the Guardrails in the Pipeline

Cultural norms decay under deadline pressure; pipeline gates do not. Where a rule can be enforced mechanically, enforce it mechanically, so the safe path and the easy path are the same path. The most valuable gate for AI-assisted infrastructure work is the one that forces a `plan` or `validate` step to run and surfaces its output to the reviewer, because that output describes what will actually happen rather than what the generated code claims will happen.

```yaml
# Pull request gate: generated infra code must be labeled and plan-checked.
name: infra-change-gate
on:
  pull_request:
    paths:
      - "terraform/**"
      - "helm/**"
jobs:
  plan:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - name: Require ai-generated label disclosure
        run: |
          # Soft signal, not a blocker: surface AI-assisted diffs for closer review.
          if git log -1 --format=%B | grep -qi 'ai-assisted'; then
            echo "::notice::This change is marked AI-assisted; reviewer should verify plan output directly."
          fi
      - name: Terraform plan (human reads this, not the generated code)
        run: |
          terraform init -input=false
          terraform validate
          terraform plan -input=false -no-color
```

The label disclosure is intentionally a soft signal rather than a hard block. The aim is not to stigmatize generated code or to pretend you can reliably detect it; it is to direct reviewer attention and to make the team's norm visible in the workflow itself. The hard gate is the `plan`: no merge without a plan a human has read. That single rule absorbs most of the risk that AI introduces into infrastructure changes, because it relocates trust from the generated text to the system's own description of the consequence.

### Mind the Data Boundary

Pasting logs, configs, and source into an external service is publishing it to a third party. For many teams that is fine for some data and unacceptable for other data, and the line has to be drawn explicitly rather than left to whoever is in a hurry at 2 AM. Know what your assistant retains, where it sends data, and which categories of information, customer data, secrets, internal hostnames, are off-limits. This is a governance decision, not a per-engineer judgment call.

### Invest in Fundamentals Anyway

Because AI amplifies expertise rather than supplying it, the teams that benefit most are the ones that keep investing in the underlying skills. The engineer who understands `NetworkPolicy` semantics can spot the subtly wrong selector the AI generated. The one who does not will ship it. Adoption is not a substitute for depth; it is a multiplier on it, and a multiplier on zero is zero.

## A Phased Rollout Playbook

Principles are easier to agree with than to operationalize. For a team moving from ad-hoc to deliberate adoption, a staged rollout keeps the risk bounded while the habits form.

### Phase One: Read-Only and Generative Only

Start where the downside is smallest. Permit AI for tasks that produce nothing that touches production directly: drafting documentation, summarizing logs and incidents, explaining unfamiliar errors, generating code that will go through normal review before it runs anywhere. Set the data boundary explicitly before anyone starts, decide what categories of information may leave your environment, and write it down. This phase builds fluency and surfaces the team's real use cases without exposing state to risk.

### Phase Two: Scaffolding With Mandatory Verification

Once the team is comfortable, extend to generating infrastructure code, but couple it to the verification gate from the start. Generated Terraform, Helm, and CI changes are allowed, and the pipeline requires a `plan` or `validate` step whose output a human reads before merge. Agree on how generated changes are noted in PRs and recalibrate review expectations for the larger diff volume. The goal of this phase is to make "generate, then verify against the system" the default muscle memory, not an exception.

### Phase Three: Supervised Automation at the Edges

Only after the verification culture is solid should the team consider letting AI drive any action that changes state, and even then only at the edges, in non-production environments, behind dry-runs, with a human approving each specific mutation. Many teams correctly decide they never need this phase for production at all. The discipline is to treat each expansion of the leash as a deliberate decision backed by the metrics from earlier phases, not as a natural progression that happens on its own.

The sequencing matters because each phase builds the judgment the next one assumes. A team that jumps straight to letting AI act on infrastructure has skipped the steps that teach it where the tool is unreliable, which is exactly the knowledge that makes supervision meaningful rather than ceremonial.

## Choosing Deliberately

The honest framing is that this is now a choice with consequences in both directions. A team that adopts AI carelessly, merging unverified output, skipping review, leaking data, trades a temporary speed bump for systemic risk. A team that refuses to engage trades a known process for a widening throughput gap that becomes harder to close every quarter. Neither default is safe. The defensible position is deliberate adoption: integrate the tools where they demonstrably help, fence them where they demonstrably do not, and keep the verification culture that makes an operations team worth trusting.

The shift is comparable to earlier ones the industry has absorbed. Version control, CI, infrastructure-as-code, and observability all moved from optional advantage to baseline expectation, and in each case the teams that integrated them early and thoughtfully pulled ahead while the holdouts spent years catching up. AI assistance is following the same curve. The teams treating it as a deliberate, governed capability rather than a personal toy or a forbidden shortcut are the ones setting the new pace.

## Key Takeaways

- AI assistance has moved from optional advantage to baseline expectation for infrastructure, DevOps, and SRE teams; the productivity gap is now organizational, not individual, and it compounds at the team level in ways it never did for a single engineer.
- "Necessity" here means the surrounding ecosystem now assumes these tools; a team can opt out of any one tool, but opting out of the whole shift means absorbing a growing tax on every interaction with a world that did not.
- Leaving adoption to individual preference is not neutral. Uneven use erodes shared working method, makes reviews and estimates inconsistent, and fragments knowledge. The teams pulling ahead have an explicit, shared answer to "how do we use this here."
- The highest-return uses are toil reduction, IaC scaffolding, runbook and postmortem drafting, and supervised incident triage, all transformation tasks where a verified first draft saves the most time. Keep the AI on the read side of an incident and the human on the write side.
- The real limits are concrete: AI has no blast-radius awareness, produces confident plausible errors, amplifies whatever expertise you bring, and never absolves accountability.
- The team-level failure modes are quieter and costlier: review fatigue and rubber-stamping, junior skill atrophy, homogenized mediocre solutions, and diffusion of responsibility. Each degrades the system rather than producing one visible mistake.
- Measure honestly with metrics you already track: lead time should fall while change failure rate and MTTR hold or improve. Watch PR size and review latency as early warnings of rubber-stamping, and ask retrospectives where the tool helped versus cost time.
- Adopt responsibly by treating output as an untrusted first draft, keeping a human in the loop for anything stateful, verifying claims against authoritative sources rather than the model, and encoding the guardrails in the pipeline so the safe path is the easy path. The non-negotiable gate is no merge without a `plan` or `validate` output a human has read.
- Roll out in phases: read-only and generative first, then scaffolding with mandatory verification, and only then any supervised, edge-case automation, each phase building the judgment the next assumes. Many teams correctly stop before letting AI act on production at all.
- Standardize adoption across the team, set an explicit data boundary as a governance decision, and keep investing in fundamentals, because AI is a multiplier on expertise and a multiplier on zero is zero.
- Both careless adoption and outright refusal carry real cost; the defensible path is deliberate, governed integration that preserves the verification culture an ops team is trusted for.
