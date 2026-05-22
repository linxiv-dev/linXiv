"""Graph nodes/edges matching the desktop GraphPage augmentation (tags + projects)."""

from __future__ import annotations

from storage.db import get_graph_data
from storage.projects import Status, filter_projects, color_to_hex
from storage.tags import get_project_tags


def get_augmented_graph_data() -> dict:
    nodes, edges = get_graph_data()

    seen_tag_ids: set[str] = set()
    tag_edges: list[dict] = []
    for node in nodes:
        if node["type"] == "paper":
            for tag in (node.get("tags") or []):
                tag_node_id = f"tag::{tag}"
                if tag_node_id not in seen_tag_ids:
                    seen_tag_ids.add(tag_node_id)
                tag_edges.append({"source": node["id"], "target": tag_node_id})
    tag_nodes = [{"id": tid, "label": tid[5:], "type": "tag"} for tid in seen_tag_ids]
    nodes = nodes + tag_nodes
    edges = edges + tag_edges

    paper_to_projects: dict[int, list[int]] = {}
    for proj in filter_projects():
        if proj.id and proj.status == Status.ACTIVE:
            for sfk in proj.source_fks:
                paper_to_projects.setdefault(sfk, []).append(proj.id)
    for node in nodes:
        if node["type"] == "paper":
            node["project_ids"] = paper_to_projects.get(node["id"], [])

    return {"nodes": nodes, "edges": edges}


def project_filter_options() -> list[dict]:
    """Project chips for the graph (same shape as desktop GraphPage._load_dropdowns)."""
    out: list[dict] = []
    for p in filter_projects():
        if p.id and p.status != Status.DELETED:
            out.append(
                {
                    "id": p.id,
                    "name": p.name,
                    "color": color_to_hex(p.color) if p.color else "#5b8dee",
                    "tags": get_project_tags(p.id),
                }
            )
    return out
