"""Load tests for Compendium API.

Three user behavior classes simulate realistic usage patterns:
  - BrowsingUser (70%):  reads the knowledge graph, topics, tags
  - CaptureSubmitter (20%): submits captures with skip-domain URLs (zero LLM cost)
  - AgentQuerier (10%): asks the RAG agent questions (rate-limited to 10/min)

Run:
    pip install locust
    locust -f tests/load/locustfile.py --host=http://localhost:8001

    # Headless (CI-friendly):
    locust -f tests/load/locustfile.py --host=http://localhost:8001 \
        --headless -u 20 -r 2 -t 60s --html=tests/load/report.html
"""

import uuid
from datetime import datetime, timedelta, timezone

from locust import HttpUser, between, task


class BrowsingUser(HttpUser):
    """Simulates a user browsing their knowledge graph and topics.

    70% of traffic. Read-heavy, fast endpoints.
    """

    weight = 7
    wait_time = between(2, 5)

    @task(3)
    def view_graph(self):
        self.client.get("/api/graph", name="/api/graph")

    @task(3)
    def view_topics(self):
        self.client.get("/api/topics", name="/api/topics")

    @task(2)
    def view_tags(self):
        self.client.get("/api/tags", name="/api/tags")

    @task(2)
    def view_review_queue(self):
        self.client.get("/api/pages/review-queue", name="/api/pages/review-queue")

    @task(1)
    def health_check(self):
        self.client.get("/health", name="/health")

    @task(1)
    def view_metrics(self):
        self.client.get("/metrics", name="/metrics")


class CaptureSubmitter(HttpUser):
    """Simulates capture submissions from the browser extension.

    20% of traffic. Uses skip-domain URLs (accounts.google.com, etc.)
    so the pipeline runs without triggering LLM API calls.
    """

    weight = 2
    wait_time = between(10, 30)

    # URLs that trigger domain-skip logic (zero LLM cost)
    SKIP_URLS = [
        ("https://accounts.google.com/signin", "Sign in - Google Accounts"),
        ("https://login.microsoftonline.com/common/oauth2", "Sign in to your account"),
        ("https://mail.google.com/mail/u/0/#inbox", "Gmail - Inbox"),
        ("https://calendar.google.com/calendar/r", "Google Calendar"),
        ("https://docs.google.com/document/d/1abc/edit", "Untitled Document"),
    ]

    @task
    def submit_capture(self):
        now = datetime.now(timezone.utc)
        capture_id = f"loadtest_{uuid.uuid4().hex[:8]}"

        pages = [
            {
                "url": url,
                "title": title,
                "timestamp": (now - timedelta(minutes=5 - i)).isoformat(),
                "dwellTimeSeconds": 30 + i * 10,
                "isTrackedDomain": False,
            }
            for i, (url, title) in enumerate(self.SKIP_URLS)
        ]

        payload = {
            "captureId": capture_id,
            "pages": pages,
            "events": [],
            "startedAt": (now - timedelta(minutes=10)).isoformat(),
            "endedAt": now.isoformat(),
        }

        self.client.post(
            "/api/captures",
            json=payload,
            name="/api/captures",
        )


class AgentQuerier(HttpUser):
    """Simulates RAG agent queries.

    10% of traffic. Rate-limited to 10/min on the server,
    so expect 429 responses under load — this is expected behavior.
    """

    weight = 1
    wait_time = between(15, 30)

    QUERIES = [
        "What topics have I explored recently?",
        "Summarize what I learned about machine learning",
        "What Wikipedia articles did I read?",
        "How are my browsing topics connected?",
        "What did I learn about Python?",
    ]

    def __init__(self, *args, **kwargs):
        super().__init__(*args, **kwargs)
        self._query_idx = 0

    @task
    def ask_agent(self):
        query = self.QUERIES[self._query_idx % len(self.QUERIES)]
        self._query_idx += 1

        self.client.post(
            "/api/agent/query",
            json={"query": query},
            name="/api/agent/query",
        )
