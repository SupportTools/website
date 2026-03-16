---
title: "Volcano: Batch Scheduling for AI/ML Workloads on Kubernetes"
date: 2027-01-11T00:00:00-05:00
draft: false
tags: ["Kubernetes", "Volcano", "Batch Scheduling", "AI/ML", "GPU"]
categories: ["Kubernetes", "AI/ML", "Platform Engineering"]
author: "Matthew Mattox - mmattox@support.tools"
description: "Production guide to Volcano batch scheduler covering gang scheduling, Queue and PodGroup CRDs, fair-share algorithms, GPU sharing, PyTorch/MPI integration, and monitoring for AI/ML platform teams."
more_link: "yes"
url: "/volcano-batch-scheduling-kubernetes-ai-workloads-guide/"
---

The default Kubernetes scheduler was designed for long-running services. Batch workloads — distributed training jobs, MPI jobs, Spark applications — have fundamentally different requirements: a PyTorch training job that receives only 7 of its required 8 GPU workers is 100% wasted compute, not a partially successful deployment. **Volcano** extends Kubernetes with a batch-aware scheduler that understands these all-or-nothing semantics, provides fair-share queue management, and integrates directly with the frameworks data scientists already use.

This guide covers Volcano's architecture, Queue and PodGroup primitives, gang scheduling for distributed training, job plugins, bin-packing strategies, GPU sharing, preemption, and the observability patterns needed to operate an AI/ML platform.

<!--more-->

## Volcano Architecture

Volcano adds three components to the Kubernetes control plane.

**volcano-scheduler** replaces or supplements the default Kubernetes scheduler for batch workloads. It runs configurable scheduling actions (allocate, preempt, reclaim, backfill) and plugins (gang, binpack, proportion, priority, drf) that compose into a scheduling pipeline.

**volcano-controller** manages the lifecycle of Volcano-specific CRDs: Job, Queue, PodGroup, and Command. It creates PodGroups from Job specs, monitors completion, and handles job-level failure policies.

**volcano-admission** validates and mutates Volcano resources at admission time. It injects the `volcano.sh/job-name` label onto pods, sets default queue assignments, and enforces queue capacity constraints.

### Scheduling Pipeline

```
Job submitted → volcano-controller creates PodGroup
                                              │
                        volcano-scheduler picks up PodGroup
                                              │
                    ┌─────────────────────────┼──────────────────┐
                    │                         │                  │
                 Action: allocate      Action: preempt     Action: backfill
                    │
              ┌─────┴────────┐
              │              │
           Plugin: gang   Plugin: proportion (queue fair-share)
              │              │
           Plugin: binpack   Plugin: priority
              │
         Pods scheduled if and only if minAvailable members can all start
```

## Installation

```bash
helm repo add volcano-sh https://volcano-sh.github.io/helm-charts
helm repo update

kubectl create namespace volcano-system

helm upgrade --install volcano volcano-sh/volcano \
  --namespace volcano-system \
  --version 1.9.0 \
  --set basic.image_pull_policy=IfNotPresent \
  --set basic.scheduler_config_file=volcano-scheduler.conf \
  --wait

# Verify all components are running
kubectl -n volcano-system get pods
```

### Scheduler Configuration

```yaml
# volcano-scheduler-configmap
apiVersion: v1
kind: ConfigMap
metadata:
  name: volcano-scheduler-configmap
  namespace: volcano-system
data:
  volcano-scheduler.conf: |
    actions: "enqueue, allocate, backfill"
    tiers:
      - plugins:
          - name: priority
          - name: gang
            arguments:
              strict-mode: true    # Do not allocate partial PodGroups
          - name: conformance
      - plugins:
          - name: drf              # Dominant Resource Fairness
          - name: predicates
          - name: proportion       # Queue proportional fair-share
          - name: nodeorder
          - name: binpack
            arguments:
              binpack.weight: 1
              binpack.cpu.weight: 1
              binpack.memory.weight: 1
              binpack.resources.weight: 1
              binpack.resources: nvidia.com/gpu
```

## Queue and PodGroup CRDs

### Queue

A **Queue** is the resource boundary for a group of jobs. Queues have capacity (hard limits) and weight (relative fair-share allocation when the cluster is under contention).

```yaml
# Default queue — all jobs go here unless overridden
apiVersion: scheduling.volcano.sh/v1beta1
kind: Queue
metadata:
  name: default
spec:
  weight: 1
  reclaimable: true
  capability:
    cpu: "10"
    memory: 20Gi
---
# High-priority production training queue
apiVersion: scheduling.volcano.sh/v1beta1
kind: Queue
metadata:
  name: ml-production
spec:
  weight: 4          # 4× the resources of the default queue under contention
  reclaimable: true
  capability:
    cpu: "80"
    memory: 320Gi
    nvidia.com/gpu: "16"
  guarantee:
    resource:
      cpu: "16"
      memory: 64Gi
      nvidia.com/gpu: "4"    # Always reserve these GPUs for this queue
---
# Low-priority research queue — can be preempted
apiVersion: scheduling.volcano.sh/v1beta1
kind: Queue
metadata:
  name: ml-research
spec:
  weight: 1
  reclaimable: true    # jobs in this queue can be reclaimed by higher-priority queues
  capability:
    cpu: "40"
    memory: 160Gi
    nvidia.com/gpu: "8"
---
# CI/CD queue for automated model validation
apiVersion: scheduling.volcano.sh/v1beta1
kind: Queue
metadata:
  name: ml-ci
spec:
  weight: 2
  reclaimable: false   # CI jobs are not preempted mid-run
  capability:
    cpu: "20"
    memory: 40Gi
    nvidia.com/gpu: "4"
```

### Queue Hierarchy

```yaml
# Parent queue — top-level resource boundary for the ML team
apiVersion: scheduling.volcano.sh/v1beta1
kind: Queue
metadata:
  name: ml-team
spec:
  weight: 10
  capability:
    cpu: "160"
    memory: 640Gi
    nvidia.com/gpu: "32"
---
# Child queue — inherits from parent
apiVersion: scheduling.volcano.sh/v1beta1
kind: Queue
metadata:
  name: ml-team-nlp
  annotations:
    volcano.sh/parent-queue: ml-team
spec:
  weight: 3
  capability:
    cpu: "60"
    memory: 240Gi
    nvidia.com/gpu: "12"
---
apiVersion: scheduling.volcano.sh/v1beta1
kind: Queue
metadata:
  name: ml-team-cv
  annotations:
    volcano.sh/parent-queue: ml-team
spec:
  weight: 7
  capability:
    cpu: "100"
    memory: 400Gi
    nvidia.com/gpu: "20"
```

### PodGroup

A **PodGroup** declares the minimum number of pods that must be schedulable simultaneously before any pod in the group is allowed to start. This is the gang scheduling primitive.

```yaml
apiVersion: scheduling.volcano.sh/v1beta1
kind: PodGroup
metadata:
  name: pytorch-training-001
  namespace: ml-jobs
spec:
  minMember: 8         # All 8 pods must be schedulable before any starts
  queue: ml-production
  priorityClassName: ml-high-priority
  minResources:
    cpu: "64"
    memory: 256Gi
    nvidia.com/gpu: "8"
```

In most cases, PodGroups are created automatically by Volcano when using the `Job` CRD or when using the Kubeflow/PyTorch operator integration.

## Volcano Job for MPI Workloads

The Volcano `Job` CRD describes multi-role batch jobs (master, worker, parameter server) with lifecycle policies.

### MPI Distributed Training Job

```yaml
apiVersion: batch.volcano.sh/v1alpha1
kind: Job
metadata:
  name: mpi-training-resnet50
  namespace: ml-jobs
spec:
  minAvailable: 5      # 1 master + 4 workers must start together
  schedulerName: volcano
  queue: ml-production
  priorityClassName: ml-high-priority

  # Plugins wire up SSH access and environment variables between roles
  plugins:
    ssh: []
    svc: []
    env: []

  # Job-level failure policy
  policies:
    - event: PodEvicted
      action: RestartJob
    - event: PodFailed
      action: RestartJob
    - event: TaskCompleted
      action: CompleteJob

  tasks:
    - name: master
      replicas: 1
      policies:
        - event: TaskCompleted
          action: CompleteJob
      template:
        spec:
          schedulerName: volcano
          containers:
            - name: mpi-master
              image: registry.internal/mpi-pytorch:2.2.0-cuda12.1
              command:
                - mpirun
                - --allow-run-as-root
                - -np
                - "4"
                - --hostfile
                - /etc/volcano/mpiworker.host
                - python
                - /workspace/train_resnet50.py
                - --epochs=100
                - --batch-size=256
                - --data-dir=/data/imagenet
              resources:
                requests:
                  cpu: "4"
                  memory: 16Gi
                limits:
                  cpu: "8"
                  memory: 32Gi
              volumeMounts:
                - name: training-data
                  mountPath: /data
                - name: model-output
                  mountPath: /output
          restartPolicy: OnFailure
          volumes:
            - name: training-data
              persistentVolumeClaim:
                claimName: imagenet-data-pvc
            - name: model-output
              persistentVolumeClaim:
                claimName: model-output-pvc

    - name: worker
      replicas: 4
      template:
        spec:
          schedulerName: volcano
          containers:
            - name: mpi-worker
              image: registry.internal/mpi-pytorch:2.2.0-cuda12.1
              command:
                - /usr/sbin/sshd
                - -D
              resources:
                requests:
                  cpu: "8"
                  memory: 32Gi
                  nvidia.com/gpu: "1"
                limits:
                  cpu: "16"
                  memory: 64Gi
                  nvidia.com/gpu: "1"
              volumeMounts:
                - name: training-data
                  mountPath: /data
                - name: model-output
                  mountPath: /output
          restartPolicy: OnFailure
          volumes:
            - name: training-data
              persistentVolumeClaim:
                claimName: imagenet-data-pvc
            - name: model-output
              persistentVolumeClaim:
                claimName: model-output-pvc
```

## Gang Scheduling for PyTorch Distributed Training

When using the PyTorch Training Operator (Kubeflow), Volcano integrates via the scheduler name field:

```yaml
apiVersion: kubeflow.org/v1
kind: PyTorchJob
metadata:
  name: bert-finetuning
  namespace: ml-jobs
  labels:
    volcano.sh/queue-name: ml-production
spec:
  pytorchReplicaSpecs:
    Master:
      replicas: 1
      restartPolicy: OnFailure
      template:
        metadata:
          annotations:
            scheduling.volcano.sh/group-name: bert-finetuning
            scheduling.volcano.sh/group-min-member: "9"  # 1 master + 8 workers
        spec:
          schedulerName: volcano
          containers:
            - name: pytorch
              image: registry.internal/pytorch:2.2.0-cuda12.1
              command:
                - python
                - -m
                - torch.distributed.launch
                - --nproc_per_node=1
                - /workspace/finetune_bert.py
              resources:
                requests:
                  cpu: "4"
                  memory: 32Gi
                  nvidia.com/gpu: "1"
                limits:
                  cpu: "8"
                  memory: 64Gi
                  nvidia.com/gpu: "1"
              env:
                - name: NCCL_IB_DISABLE
                  value: "0"
                - name: NCCL_SOCKET_IFNAME
                  value: eth0

    Worker:
      replicas: 8
      restartPolicy: OnFailure
      template:
        metadata:
          annotations:
            scheduling.volcano.sh/group-name: bert-finetuning
        spec:
          schedulerName: volcano
          nodeSelector:
            node-role.kubernetes.io/gpu-worker: "true"
          tolerations:
            - key: "nvidia.com/gpu"
              operator: "Exists"
              effect: "NoSchedule"
          containers:
            - name: pytorch
              image: registry.internal/pytorch:2.2.0-cuda12.1
              command:
                - python
                - -m
                - torch.distributed.launch
                - --nproc_per_node=1
                - /workspace/finetune_bert.py
              resources:
                requests:
                  cpu: "8"
                  memory: 64Gi
                  nvidia.com/gpu: "1"
                limits:
                  cpu: "16"
                  memory: 128Gi
                  nvidia.com/gpu: "1"
```

## Job Plugins

### env Plugin

The `env` plugin injects environment variables into each pod describing the job topology: the pod's role, index within its task, total replicas, and the service addresses of other roles.

```bash
# Environment variables injected by the env plugin
VK_TASK_INDEX=2                        # This pod's index within its task
VK_TASK_NUM=8                          # Total pods in this task
VK_JOB_NAME=bert-finetuning            # Job name
VK_JOB_NAMESPACE=ml-jobs               # Job namespace
```

### svc Plugin

The `svc` plugin creates a headless Service for each task in the job, enabling stable DNS-based discovery between roles. Workers can reach the master at `<job-name>-master-0.<job-name>.<namespace>.svc.cluster.local`.

### ssh Plugin

The `ssh` plugin creates SSH keys and distributes them via ConfigMaps and Secrets, enabling passwordless SSH between pods — required for MPI's `mpirun` to launch workers.

## Bin-Packing vs Spread Strategies

### Bin-Packing for GPU Utilisation

Bin-packing places pods on the fewest possible nodes, maximising GPU utilisation per node and leaving entire nodes free for large exclusive jobs:

```yaml
# Scheduler configuration that prioritises bin-packing
apiVersion: v1
kind: ConfigMap
metadata:
  name: volcano-scheduler-configmap
  namespace: volcano-system
data:
  volcano-scheduler.conf: |
    actions: "enqueue, allocate, backfill"
    tiers:
      - plugins:
          - name: priority
          - name: gang
          - name: conformance
      - plugins:
          - name: drf
          - name: predicates
          - name: proportion
          - name: nodeorder
            arguments:
              leastrequested.weight: 0      # Do not favour least-loaded nodes
              mostrequested.weight: 1        # Favour most-loaded nodes (bin-pack)
          - name: binpack
            arguments:
              binpack.weight: 10
              binpack.cpu.weight: 1
              binpack.memory.weight: 1
              binpack.resources: nvidia.com/gpu
              binpack.resources.nvidia.com/gpu.weight: 10   # Prioritise GPU packing
```

### Spread for Fault Tolerance

For long-running training jobs where node failure tolerance matters more than utilisation density:

```yaml
# Node order configuration for spread scheduling
- name: nodeorder
  arguments:
    leastrequested.weight: 10     # Prefer least-loaded nodes
    mostrequested.weight: 0
    resourcequota.weight: 2
```

Combine spread scheduling at the Volcano level with pod anti-affinity in the job spec for maximum resilience:

```yaml
# Add to the worker task template spec
affinity:
  podAntiAffinity:
    preferredDuringSchedulingIgnoredDuringExecution:
      - weight: 100
        podAffinityTerm:
          labelSelector:
            matchLabels:
              volcano.sh/job-name: bert-finetuning
              volcano.sh/task-spec: worker
          topologyKey: kubernetes.io/hostname
```

## Fair-Share Scheduling with DRF

Dominant Resource Fairness (DRF) prevents a single team from monopolising the cluster by tracking the dominant resource (typically GPU) usage per queue and scheduling to equalise it.

When a GPU cluster has three queues competing for 32 GPUs:

- `ml-production` (weight 4): gets 16 GPUs
- `ml-research` (weight 2): gets 8 GPUs
- `ml-ci` (weight 2): gets 8 GPUs

If `ml-research` is idle, its allocation is distributed proportionally to the other queues until it submits new jobs.

### Priority within a Queue

```yaml
apiVersion: scheduling.k8s.io/v1
kind: PriorityClass
metadata:
  name: ml-high-priority
value: 1000
globalDefault: false
description: "High-priority ML jobs — preempts lower-priority workloads"
---
apiVersion: scheduling.k8s.io/v1
kind: PriorityClass
metadata:
  name: ml-normal-priority
value: 500
globalDefault: false
description: "Normal ML job priority"
---
apiVersion: scheduling.k8s.io/v1
kind: PriorityClass
metadata:
  name: ml-low-priority
value: 100
globalDefault: true
description: "Low-priority background jobs — preemptible"
```

## GPU Sharing

For inference workloads that do not saturate a full GPU, Volcano works with NVIDIA's MIG (Multi-Instance GPU) partitioning and with third-party GPU sharing solutions.

### MIG-Backed GPU Slices

```yaml
# Request a 1/7 slice of an A100 GPU (MIG 1g.10gb profile)
resources:
  requests:
    nvidia.com/mig-1g.10gb: "1"
  limits:
    nvidia.com/mig-1g.10gb: "1"
```

### Time-Sliced GPU Sharing

With the NVIDIA GPU Operator configured for time-slicing, multiple pods can share a single GPU:

```yaml
# ConfigMap for NVIDIA GPU Operator time-slicing
apiVersion: v1
kind: ConfigMap
metadata:
  name: time-slicing-config
  namespace: gpu-operator
data:
  a100-80gb: |
    version: v1
    flags:
      migStrategy: none
    sharing:
      timeSlicing:
        resources:
          - name: nvidia.com/gpu
            replicas: 4    # Allow 4 pods to share each A100
```

Reference the time-sliced resource in small inference jobs:

```yaml
apiVersion: batch.volcano.sh/v1alpha1
kind: Job
metadata:
  name: inference-batch
  namespace: ml-jobs
spec:
  minAvailable: 1
  schedulerName: volcano
  queue: ml-production
  tasks:
    - name: inference
      replicas: 4
      template:
        spec:
          schedulerName: volcano
          containers:
            - name: inference
              image: registry.internal/torchserve:0.9.0
              resources:
                requests:
                  nvidia.com/gpu: "1"    # time-sliced — shares physical GPU
                limits:
                  nvidia.com/gpu: "1"
```

## Preemption

Volcano supports two preemption patterns.

**Queue-level preemption**: A high-priority queue can reclaim resources from a lower-priority `reclaimable: true` queue. Jobs in the lower-priority queue are evicted and re-queued.

**Job-level preemption**: Within a queue, higher `priorityClassName` jobs can preempt lower-priority jobs when the queue is at capacity.

Configure the preempt action in the scheduler:

```yaml
actions: "enqueue, allocate, preempt, reclaim, backfill"
```

For long-running training jobs, protect against preemption with checkpointing:

```yaml
# In the Job spec, use a lifecycle policy that handles eviction gracefully
policies:
  - event: PodEvicted
    action: RestartJob       # Restart from last checkpoint

# In the container spec, mount a checkpoint volume
volumeMounts:
  - name: checkpoints
    mountPath: /checkpoints

# In training code, save checkpoints every N steps
# The training script resumes from the latest checkpoint on restart
```

## Monitoring

### Prometheus Metrics

```yaml
apiVersion: monitoring.coreos.com/v1
kind: ServiceMonitor
metadata:
  name: volcano-scheduler
  namespace: monitoring
  labels:
    prometheus: kube-prometheus
spec:
  namespaceSelector:
    matchNames:
      - volcano-system
  selector:
    matchLabels:
      app: volcano-scheduler
  endpoints:
    - port: metrics
      interval: 30s
      path: /metrics
---
apiVersion: monitoring.coreos.com/v1
kind: ServiceMonitor
metadata:
  name: volcano-controller
  namespace: monitoring
spec:
  namespaceSelector:
    matchNames:
      - volcano-system
  selector:
    matchLabels:
      app: volcano-controller-manager
  endpoints:
    - port: metrics
      interval: 30s
```

### Alerting Rules

```yaml
apiVersion: monitoring.coreos.com/v1
kind: PrometheusRule
metadata:
  name: volcano-alerts
  namespace: monitoring
spec:
  groups:
    - name: volcano.rules
      rules:
        - alert: VolcanoJobFailed
          expr: |
            volcano_job_states_count{state="Failed"} > 0
          for: 1m
          labels:
            severity: critical
          annotations:
            summary: "Volcano job in Failed state"
            description: "{{ $value }} job(s) in Failed state in namespace {{ $labels.namespace }}"

        - alert: VolcanoQueueOverCapacity
          expr: |
            volcano_queue_allocated_resources_count /
            volcano_queue_capability_resources_count > 0.95
          for: 10m
          labels:
            severity: warning
          annotations:
            summary: "Queue {{ $labels.queue_name }} near capacity"
            description: "Queue at {{ $value | humanizePercentage }} of capacity"

        - alert: VolcanoPodGroupPending
          expr: |
            volcano_podgroup_phase_count{phase="Pending"} > 0
          for: 30m
          labels:
            severity: warning
          annotations:
            summary: "PodGroup stuck in Pending for >30 minutes"

        - alert: VolcanoSchedulerLatencyHigh
          expr: |
            histogram_quantile(0.99,
              rate(volcano_e2e_scheduling_latency_milliseconds_bucket[5m])
            ) > 5000
          for: 5m
          labels:
            severity: warning
          annotations:
            summary: "Volcano scheduler p99 latency above 5 seconds"
```

### Key Metrics Reference

| Metric | Description |
|---|---|
| `volcano_job_states_count` | Job count by state (Pending, Running, Completed, Failed) |
| `volcano_podgroup_phase_count` | PodGroup count by phase |
| `volcano_queue_allocated_resources_count` | Resources allocated per queue |
| `volcano_queue_capability_resources_count` | Queue capacity |
| `volcano_queue_pending_jobs_count` | Jobs waiting in queue |
| `volcano_e2e_scheduling_latency_milliseconds` | End-to-end scheduling latency |
| `volcano_scheduling_algorithm_latency_milliseconds` | Per-action scheduling latency |

## Operational Commands

```bash
# List all queues with their current allocation
kubectl get queues -o custom-columns=\
'NAME:.metadata.name,WEIGHT:.spec.weight,STATE:.status.state,\
PENDING:.status.pending,RUNNING:.status.running,\
SUCCEEDED:.status.succeeded,FAILED:.status.failed'

# List all jobs across all namespaces
kubectl get vcjobs --all-namespaces

# Inspect a specific job
kubectl -n ml-jobs describe vcjob bert-finetuning

# Check PodGroup scheduling status
kubectl -n ml-jobs get podgroup

# View scheduler logs for a specific job (useful for diagnosing why a job is pending)
kubectl -n volcano-system logs \
  -l app=volcano-scheduler \
  --tail=200 | grep bert-finetuning

# Force-kill a stuck job
kubectl -n ml-jobs delete vcjob bert-finetuning

# Suspend a queue (stops new jobs from being scheduled from this queue)
kubectl patch queue ml-research \
  --type=merge \
  -p '{"spec":{"state":"closed"}}'

# Re-open a queue
kubectl patch queue ml-research \
  --type=merge \
  -p '{"spec":{"state":"open"}}'
```

## Integration with Kubeflow Pipelines

Volcano integrates with Kubeflow Pipelines as the execution backend for batch steps. Configure the Kubeflow notebook controller to use Volcano for training steps:

```yaml
# In the Kubeflow Pipeline DSL, annotate components to use Volcano
from kfp import dsl

@dsl.pipeline(name='bert-training-pipeline')
def bert_pipeline(
    dataset_path: str,
    num_workers: int = 8,
    epochs: int = 10,
):
    train_op = dsl.ContainerOp(
        name='distributed-training',
        image='registry.internal/pytorch:2.2.0-cuda12.1',
        command=['python', '/workspace/train.py'],
        arguments=['--epochs', epochs, '--data', dataset_path],
    )
    train_op.add_pod_annotation(
        'scheduling.volcano.sh/group-name', 'bert-pipeline-train'
    )
    train_op.add_pod_annotation(
        'scheduling.volcano.sh/group-min-member', str(num_workers + 1)
    )
    train_op.container.set_gpu_limit(1)
    train_op.set_retry(3)
```

Volcano fundamentally changes the economics of running AI/ML workloads on Kubernetes. By replacing optimistic individual-pod scheduling with gang-aware allocation, fair-share queues, and preemption, it ensures that GPU clusters operate at high utilisation without the wasted compute and cascading timeouts that plague standard-scheduler-based ML platforms.
