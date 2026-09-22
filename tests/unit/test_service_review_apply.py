from __future__ import annotations

import uuid

import pytest

from app.core.exceptions import ConflictError, NotFoundError
from app.interlink.link_applier import LinkApplicationError
from app.interlink.models import InternalLinkSuggestion, SuggestionStatus
from tests.conftest import Site
from tests.fakes import FakeContentStore, build_service

CONTEXT = "Businesses can use AI voice agents to automate repetitive customer support interactions."


def _suggestion(site: Site, status: SuggestionStatus = SuggestionStatus.PENDING, **kw: object):  # type: ignore[no-untyped-def]
    values: dict[str, object] = {
        "source_page_id": site.source.id,
        "target_page_id": site.voice.id,
        "anchor_text": "AI voice agents",
        "context": CONTEXT,
        "status": status,
    }
    values.update(kw)
    return site.repo.put_suggestion(**values)


# ---------------------------------------------------------------- approve / reject


def test_approve_flow(site: Site) -> None:
    s = _suggestion(site)
    result = build_service(site.repo).approve(s.id)
    assert result.status == SuggestionStatus.APPROVED
    assert result.reviewed_at is not None
    assert site.repo.commits == 1


def test_reject_flow_with_reason(site: Site) -> None:
    s = _suggestion(site)
    result = build_service(site.repo).reject(s.id, "Not a good fit")
    assert result.status == SuggestionStatus.REJECTED
    assert result.rejection_reason == "Not a good fit"


def test_rejected_can_be_re_approved_and_approved_can_be_rejected(site: Site) -> None:
    s = _suggestion(site, SuggestionStatus.REJECTED, rejection_reason="x")
    service = build_service(site.repo)
    assert service.approve(s.id).rejection_reason is None
    assert service.reject(s.id, None).status == SuggestionStatus.REJECTED


def test_re_approve_conflicts_with_newer_active_suggestion(site: Site) -> None:
    old = _suggestion(site, SuggestionStatus.REJECTED)
    _suggestion(site, SuggestionStatus.PENDING)
    with pytest.raises(ConflictError) as exc:
        build_service(site.repo).approve(old.id)
    assert exc.value.code == "ACTIVE_SUGGESTION_EXISTS"


@pytest.mark.parametrize(
    ("status", "action"),
    [
        (SuggestionStatus.APPROVED, "approve"),
        (SuggestionStatus.APPLIED, "approve"),
        (SuggestionStatus.REJECTED, "reject"),
        (SuggestionStatus.APPLIED, "reject"),
    ],
)
def test_invalid_transitions(site: Site, status: SuggestionStatus, action: str) -> None:
    s = _suggestion(site, status)
    service = build_service(site.repo)
    with pytest.raises(ConflictError) as exc:
        service.approve(s.id) if action == "approve" else service.reject(s.id, None)
    assert exc.value.code == "INVALID_STATUS_TRANSITION"
    assert s.status == status


def test_unknown_suggestion(site: Site) -> None:
    service = build_service(site.repo)
    for call in (service.approve, service.apply, service.get_suggestion):
        with pytest.raises(NotFoundError) as exc:
            call(uuid.uuid4())
        assert exc.value.code == "SUGGESTION_NOT_FOUND"


# ---------------------------------------------------------------- apply


def _apply(site: Site, s: InternalLinkSuggestion, store: FakeContentStore | None = None):  # type: ignore[no-untyped-def]
    return build_service(site.repo, store=store or FakeContentStore()).apply(s.id)


def test_apply_flow(site: Site) -> None:
    s = _suggestion(site, SuggestionStatus.APPROVED)
    store = FakeContentStore()
    before = site.source.content_html or ""
    result = _apply(site, s, store)

    assert result.status == SuggestionStatus.APPLIED
    assert result.applied_at is not None
    after = site.source.content_html or ""
    linked = '<a href="/ai-voice-agent/">AI voice agents</a> to automate repetitive'
    assert linked in after
    assert after.count('href="/ai-voice-agent/"') == 1
    # Script/style/nav/footer occurrences are untouched and nothing else changed.
    assert (
        after.replace('<a href="/ai-voice-agent/">AI voice agents</a>', "AI voice agents", 1)
        == before
    )
    assert 'var promo = "AI voice agents"' in after
    assert site.source.content_version == 2
    assert site.voice.url in site.source.outgoing_links
    assert len(store.saved) == 1


def test_apply_requires_approved_status(site: Site) -> None:
    for status in (SuggestionStatus.PENDING, SuggestionStatus.REJECTED, SuggestionStatus.APPLIED):
        site.repo.suggestions.clear()
        s = _suggestion(site, status)
        with pytest.raises(ConflictError) as exc:
            _apply(site, s)
        assert exc.value.code == "SUGGESTION_NOT_APPROVED"
    assert site.repo.rollbacks == 3


def test_apply_twice_is_rejected(site: Site) -> None:
    s = _suggestion(site, SuggestionStatus.APPROVED)
    _apply(site, s)
    with pytest.raises(ConflictError):
        _apply(site, s)
    assert (site.source.content_html or "").count('href="/ai-voice-agent/"') == 1


def test_apply_detects_existing_link(site: Site) -> None:
    site.source.content_html = (site.source.content_html or "").replace(
        "</body>", '<p>See <a href="https://example.com/ai-voice-agent">our agents</a>.</p></body>'
    )
    s = _suggestion(site, SuggestionStatus.APPROVED)
    store = FakeContentStore()
    with pytest.raises(ConflictError) as exc:
        _apply(site, s, store)
    assert exc.value.code == "ALREADY_LINKED"
    assert store.saved == []
    assert s.status == SuggestionStatus.APPROVED


def test_apply_revalidates_target(site: Site) -> None:
    s = _suggestion(site, SuggestionStatus.APPROVED)
    site.voice.has_noindex = True
    with pytest.raises(ConflictError) as exc:
        _apply(site, s)
    assert exc.value.code == "TARGET_NOT_LINKABLE"
    assert exc.value.details == {"reason": "NOINDEX"}

    site.voice.has_noindex = False
    site.voice.canonical_url = "https://www.example.com/somewhere-else/"
    with pytest.raises(ConflictError) as exc:
        _apply(site, s)
    assert exc.value.details == {"reason": "CANONICAL_POINTS_ELSEWHERE"}

    site.voice.canonical_url = None
    site.voice.http_status = 404
    with pytest.raises(ConflictError) as exc:
        _apply(site, s)
    assert exc.value.details == {"reason": "HTTP_404"}


def test_apply_when_pages_disappeared(site: Site) -> None:
    s = _suggestion(site, SuggestionStatus.APPROVED)
    del site.repo.pages[site.voice.id]
    with pytest.raises(ConflictError) as exc:
        _apply(site, s)
    assert exc.value.code == "TARGET_PAGE_MISSING"
    del site.repo.pages[site.source.id]
    with pytest.raises(ConflictError) as exc:
        _apply(site, s)
    assert exc.value.code == "SOURCE_PAGE_MISSING"


def test_apply_when_context_was_edited_away(site: Site) -> None:
    s = _suggestion(site, SuggestionStatus.APPROVED)
    site.source.content_html = "<p>The page was rewritten entirely.</p>"
    store = FakeContentStore()
    with pytest.raises(LinkApplicationError) as exc:
        _apply(site, s, store)
    assert exc.value.code == "CONTEXT_NOT_FOUND"
    assert store.saved == []
    assert s.status == SuggestionStatus.APPROVED


def test_apply_never_creates_nested_link(site: Site) -> None:
    site.source.content_html = (
        '<p>Businesses can use <a href="/pricing/">AI voice agents</a> to automate repetitive '
        "customer support interactions.</p>"
    )
    site.source.outgoing_links = ["https://www.example.com/pricing/"]
    s = _suggestion(site, SuggestionStatus.APPROVED)
    with pytest.raises(LinkApplicationError) as exc:
        _apply(site, s)
    assert exc.value.code == "ANCHOR_IN_UNSAFE_ELEMENT"


def test_apply_content_version_conflict(site: Site) -> None:
    s = _suggestion(site, SuggestionStatus.APPROVED)

    class RacingStore(FakeContentStore):
        def save_content(self, page, new_content, *, expected_version):  # type: ignore[no-untyped-def]
            raise ConflictError("changed", code="CONTENT_VERSION_CONFLICT")

    with pytest.raises(ConflictError) as exc:
        _apply(site, s, RacingStore())
    assert exc.value.code == "CONTENT_VERSION_CONFLICT"
    assert s.status == SuggestionStatus.APPROVED
