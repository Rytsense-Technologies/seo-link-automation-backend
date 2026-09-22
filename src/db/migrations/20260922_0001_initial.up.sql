

CREATE TABLE alembic_version (
    version_num VARCHAR(32) NOT NULL, 
    CONSTRAINT alembic_version_pkc PRIMARY KEY (version_num)
);

-- Running upgrade  -> 20260922_0001

CREATE TABLE sites (
    id UUID NOT NULL, 
    name VARCHAR(255) NOT NULL, 
    base_url VARCHAR(2048) NOT NULL, 
    default_language VARCHAR(16), 
    default_region VARCHAR(16), 
    created_at TIMESTAMP WITH TIME ZONE DEFAULT now() NOT NULL, 
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT now() NOT NULL, 
    CONSTRAINT pk_sites PRIMARY KEY (id), 
    CONSTRAINT uq_sites_base_url UNIQUE (base_url)
);

CREATE TABLE pages (
    id UUID NOT NULL, 
    site_id UUID NOT NULL, 
    url VARCHAR(2048) NOT NULL, 
    title TEXT, 
    h1 TEXT, 
    meta_description TEXT, 
    content_html TEXT, 
    content_version INTEGER DEFAULT 1 NOT NULL, 
    canonical_url VARCHAR(2048), 
    http_status INTEGER, 
    redirect_url VARCHAR(2048), 
    is_indexable BOOLEAN DEFAULT true NOT NULL, 
    has_noindex BOOLEAN DEFAULT false NOT NULL, 
    language VARCHAR(16), 
    region VARCHAR(16), 
    page_type VARCHAR(64), 
    keywords TEXT[] DEFAULT '{}' NOT NULL, 
    outgoing_links TEXT[] DEFAULT '{}' NOT NULL, 
    last_crawled_at TIMESTAMP WITH TIME ZONE, 
    created_at TIMESTAMP WITH TIME ZONE DEFAULT now() NOT NULL, 
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT now() NOT NULL, 
    CONSTRAINT pk_pages PRIMARY KEY (id), 
    CONSTRAINT fk_pages_site_id_sites FOREIGN KEY(site_id) REFERENCES sites (id) ON DELETE CASCADE, 
    CONSTRAINT uq_pages_site_id_url UNIQUE (site_id, url)
);

CREATE INDEX ix_pages_site_id ON pages (site_id);

CREATE INDEX ix_pages_http_status ON pages (http_status);

CREATE TYPE interlink_suggestion_status AS ENUM ('PENDING', 'APPROVED', 'REJECTED', 'APPLIED');

CREATE TABLE internal_link_suggestions (
    id UUID NOT NULL, 
    site_id UUID NOT NULL, 
    source_page_id UUID NOT NULL, 
    target_page_id UUID NOT NULL, 
    anchor_text VARCHAR(255) NOT NULL, 
    context TEXT NOT NULL, 
    relevance_score INTEGER NOT NULL, 
    reason TEXT NOT NULL, 
    status interlink_suggestion_status NOT NULL, 
    retrieval_score FLOAT, 
    ai_provider VARCHAR(32), 
    ai_model VARCHAR(128), 
    rejection_reason TEXT, 
    reviewed_at TIMESTAMP WITH TIME ZONE, 
    applied_at TIMESTAMP WITH TIME ZONE, 
    created_at TIMESTAMP WITH TIME ZONE DEFAULT now() NOT NULL, 
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT now() NOT NULL, 
    CONSTRAINT pk_internal_link_suggestions PRIMARY KEY (id), 
    CONSTRAINT ck_internal_link_suggestions_relevance_score_range CHECK (relevance_score BETWEEN 0 AND 100), 
    CONSTRAINT ck_internal_link_suggestions_no_self_link CHECK (source_page_id <> target_page_id), 
    CONSTRAINT fk_internal_link_suggestions_site_id_sites FOREIGN KEY(site_id) REFERENCES sites (id) ON DELETE CASCADE, 
    CONSTRAINT fk_internal_link_suggestions_source_page_id_pages FOREIGN KEY(source_page_id) REFERENCES pages (id) ON DELETE CASCADE, 
    CONSTRAINT fk_internal_link_suggestions_target_page_id_pages FOREIGN KEY(target_page_id) REFERENCES pages (id) ON DELETE CASCADE
);

CREATE INDEX ix_internal_link_suggestions_site_id ON internal_link_suggestions (site_id);

CREATE INDEX ix_internal_link_suggestions_source_page_id ON internal_link_suggestions (source_page_id);

CREATE INDEX ix_internal_link_suggestions_target_page_id ON internal_link_suggestions (target_page_id);

CREATE INDEX ix_internal_link_suggestions_status_score ON internal_link_suggestions (status, relevance_score);

CREATE UNIQUE INDEX uq_internal_link_suggestions_active_pair ON internal_link_suggestions (source_page_id, target_page_id) WHERE status IN ('PENDING', 'APPROVED', 'APPLIED');




