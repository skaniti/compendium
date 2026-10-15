"""Clustering eval harness: run the production clustering code offline and score
the partition against a labelled page set.

Subpackage layout:

- ``scoring``       -- purity / ARI / NMI / keep-coverage against ``page_annotations.jsonl``
                       (+ ``topic_map.json``); the metric definitions are frozen so a number
                       in one run record means the same thing in every other.
- ``export_loader`` -- read-only loader for a ``*.jsonl.gz`` table export (one JSON object
                       per line), reproducing ``page_repo.get_active_pages`` in memory.
- ``harness``       -- drives ``ClusteringService`` (load -> filter -> embed -> HDBSCAN),
                       computes structure metrics, guard-set cohesion and scores, and
                       writes a run record.
- ``cluster_eval``  -- the CLI (``python -m evaluation.clustering.cluster_eval``).

The labelled dataset and the export are PRIVATE inputs: they live outside the repo and
are passed by path. Nothing here copies page text, titles or URLs into a tracked file;
run records hold page ids only unless ``--with-titles`` is given.
"""
