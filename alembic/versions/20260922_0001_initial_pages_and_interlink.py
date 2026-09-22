"""Page inventory (sites, pages) and internal-link suggestions

Revision ID: 20260922_0001
Revises:
Create Date: 2026-09-22
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "20260922_0001"
down_revision: str | None = None
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

STATUS_VALUES = ("PENDING", "APPROVED", "REJECTED", "APPLIED")


def upgrade() -> None:
    op.create_table(
        "sites",
        sa.Column("id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("name", sa.String(length=255), nullable=False),
        sa.Column("base_url", sa.String(length=2048), nullable=False),
        sa.Column("default_language", sa.String(length=16), nullable=True),
        sa.Column("default_region", sa.String(length=16), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=False),
        sa.PrimaryKeyConstraint("id", name="pk_sites"),
        sa.UniqueConstraint("base_url", name="uq_sites_base_url"),
    )

    op.create_table(
        "pages",
        sa.Column("id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("site_id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("url", sa.String(length=2048), nullable=False),
        sa.Column("title", sa.Text(), nullable=True),
        sa.Column("h1", sa.Text(), nullable=True),
        sa.Column("meta_description", sa.Text(), nullable=True),
        sa.Column("content_html", sa.Text(), nullable=True),
        sa.Column("content_version", sa.Integer(), server_default=sa.text("1"), nullable=False),
        sa.Column("canonical_url", sa.String(length=2048), nullable=True),
        sa.Column("http_status", sa.Integer(), nullable=True),
        sa.Column("redirect_url", sa.String(length=2048), nullable=True),
        sa.Column("is_indexable", sa.Boolean(), server_default=sa.text("true"), nullable=False),
        sa.Column("has_noindex", sa.Boolean(), server_default=sa.text("false"), nullable=False),
        sa.Column("language", sa.String(length=16), nullable=True),
        sa.Column("region", sa.String(length=16), nullable=True),
        sa.Column("page_type", sa.String(length=64), nullable=True),
        sa.Column("keywords", postgresql.ARRAY(sa.Text()), server_default=sa.text("'{}'"), nullable=False),
        sa.Column("outgoing_links", postgresql.ARRAY(sa.Text()), server_default=sa.text("'{}'"), nullable=False),
        sa.Column("last_crawled_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=False),
        sa.ForeignKeyConstraint(["site_id"], ["sites.id"], name="fk_pages_site_id_sites", ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id", name="pk_pages"),
        sa.UniqueConstraint("site_id", "url", name="uq_pages_site_id_url"),
    )
    op.create_index("ix_pages_site_id", "pages", ["site_id"])
    op.create_index("ix_pages_http_status", "pages", ["http_status"])

    status_enum = postgresql.ENUM(*STATUS_VALUES, name="interlink_suggestion_status", create_type=False)
    status_enum.create(op.get_bind(), checkfirst=True)

    op.create_table(
        "internal_link_suggestions",
        sa.Column("id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("site_id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("source_page_id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("target_page_id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("anchor_text", sa.String(length=255), nullable=False),
        sa.Column("context", sa.Text(), nullable=False),
        sa.Column("relevance_score", sa.Integer(), nullable=False),
        sa.Column("reason", sa.Text(), nullable=False),
        sa.Column("status", status_enum, nullable=False),
        sa.Column("retrieval_score", sa.Float(), nullable=True),
        sa.Column("ai_provider", sa.String(length=32), nullable=True),
        sa.Column("ai_model", sa.String(length=128), nullable=True),
        sa.Column("rejection_reason", sa.Text(), nullable=True),
        sa.Column("reviewed_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("applied_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=False),
        sa.CheckConstraint("relevance_score BETWEEN 0 AND 100", name=op.f("ck_internal_link_suggestions_relevance_score_range")),
        sa.CheckConstraint("source_page_id <> target_page_id", name=op.f("ck_internal_link_suggestions_no_self_link")),
        sa.ForeignKeyConstraint(["site_id"], ["sites.id"], name="fk_internal_link_suggestions_site_id_sites", ondelete="CASCADE"),
        sa.ForeignKeyConstraint(["source_page_id"], ["pages.id"], name="fk_internal_link_suggestions_source_page_id_pages", ondelete="CASCADE"),
        sa.ForeignKeyConstraint(["target_page_id"], ["pages.id"], name="fk_internal_link_suggestions_target_page_id_pages", ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id", name="pk_internal_link_suggestions"),
    )
    op.create_index("ix_internal_link_suggestions_site_id", "internal_link_suggestions", ["site_id"])
    op.create_index("ix_internal_link_suggestions_source_page_id", "internal_link_suggestions", ["source_page_id"])
    op.create_index("ix_internal_link_suggestions_target_page_id", "internal_link_suggestions", ["target_page_id"])
    op.create_index(
        "ix_internal_link_suggestions_status_score",
        "internal_link_suggestions",
        ["status", "relevance_score"],
    )
    # At most one PENDING/APPROVED/APPLIED suggestion per source -> target pair.
    op.create_index(
        "uq_internal_link_suggestions_active_pair",
        "internal_link_suggestions",
        ["source_page_id", "target_page_id"],
        unique=True,
        postgresql_where=sa.text("status IN ('PENDING', 'APPROVED', 'APPLIED')"),
    )


def downgrade() -> None:
    op.drop_table("internal_link_suggestions")
    postgresql.ENUM(name="interlink_suggestion_status").drop(op.get_bind(), checkfirst=True)
    op.drop_index("ix_pages_http_status", table_name="pages")
    op.drop_index("ix_pages_site_id", table_name="pages")
    op.drop_table("pages")
    op.drop_table("sites")
