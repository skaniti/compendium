"""Tests for data models."""

from datetime import datetime, timedelta

from backend.models.capture import (
    PageVisit,
    CaptureInput,
    TopicCluster,
)


class TestPageVisit:
    """Tests for PageVisit model."""

    def test_create_page_visit(self):
        """Test creating a basic page visit."""
        visit = PageVisit(
            url="https://en.wikipedia.org/wiki/Titanic",
            timestamp=datetime.now(),
            title="Titanic",
        )
        assert visit.url == "https://en.wikipedia.org/wiki/Titanic"
        assert visit.title == "Titanic"
        assert visit.dwell_time_seconds is None
        assert visit.is_tracked_domain is True

    def test_page_visit_with_dwell_time(self):
        """Test page visit with dwell time."""
        visit = PageVisit(
            url="https://en.wikipedia.org/wiki/Hypothermia",
            timestamp=datetime.now(),
            dwell_time_seconds=120,
            title="Hypothermia",
        )
        assert visit.dwell_time_seconds == 120

    def test_page_visit_with_transition_type(self):
        """Test page visit with navigation source metadata."""
        visit = PageVisit(
            url="https://en.wikipedia.org/wiki/Hypothermia",
            timestamp=datetime.now(),
            title="Hypothermia",
            transition_type="link",
            transition_qualifiers=["forward_back"],
        )
        assert visit.transition_type == "link"
        assert visit.transition_qualifiers == ["forward_back"]

    def test_page_visit_transition_type_optional(self):
        """Transition fields default to None for backward compatibility."""
        visit = PageVisit(
            url="https://en.wikipedia.org/wiki/Titanic",
            timestamp=datetime.now(),
        )
        assert visit.transition_type is None
        assert visit.transition_qualifiers is None


class TestCaptureInput:
    """Tests for CaptureInput model."""

    def test_create_session(self):
        """Test creating a session."""
        start = datetime.now()
        end = start + timedelta(minutes=30)

        session = CaptureInput(
            capture_id="test_session_1",
            pages=[
                PageVisit(
                    url="https://en.wikipedia.org/wiki/Titanic",
                    timestamp=start,
                    title="Titanic",
                ),
                PageVisit(
                    url="https://en.wikipedia.org/wiki/Hypothermia",
                    timestamp=start + timedelta(minutes=5),
                    title="Hypothermia",
                ),
            ],
            started_at=start,
            ended_at=end,
        )

        assert session.capture_id == "test_session_1"
        assert len(session.pages) == 2
        assert session.duration_minutes == 30.0

    def test_tracked_pages_filter(self):
        """Test filtering to only tracked pages."""
        start = datetime.now()

        session = CaptureInput(
            capture_id="test_session_2",
            pages=[
                PageVisit(
                    url="https://en.wikipedia.org/wiki/Titanic",
                    timestamp=start,
                    title="Titanic",
                    is_tracked_domain=True,
                ),
                PageVisit(
                    url="https://example.com/random",
                    timestamp=start + timedelta(minutes=2),
                    title="Random",
                    is_tracked_domain=False,
                ),
            ],
            started_at=start,
            ended_at=start + timedelta(minutes=10),
        )

        tracked = session.tracked_pages
        assert len(tracked) == 1
        assert tracked[0].title == "Titanic"


class TestTopicCluster:
    """Tests for TopicCluster model."""

    def test_create_cluster(self):
        """Test creating a topic cluster."""
        cluster = TopicCluster(
            name="Maritime Disasters",
            pages=["Titanic", "Lusitania"],
            theme="Historical ship sinkings",
        )
        assert cluster.name == "Maritime Disasters"
        assert len(cluster.pages) == 2
