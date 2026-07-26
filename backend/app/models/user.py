"""
SQLAlchemy ORM models for the 'roles' and 'users' tables.

These classes are Python representations of tables that already exist
in the database (created by database/schema.sql). SQLAlchemy uses them
to let us write Python code instead of raw SQL when we read or write
user records.

We do NOT create the tables here — that is the job of schema.sql.
"""
from sqlalchemy import Boolean, Column, ForeignKey, Integer, String, TIMESTAMP
from sqlalchemy.orm import relationship
from sqlalchemy.sql import func

from app.database import Base


class Role(Base):
    """Maps to the 'roles' table.  e.g. Owner, Pharmacist, Billing Staff."""
    __tablename__ = "roles"

    id   = Column(Integer, primary_key=True, index=True)
    name = Column(String(50), unique=True, nullable=False)

    # One role can belong to many users — SQLAlchemy uses this to let us
    # do  role.users  to get all users with that role.
    users = relationship("User", back_populates="role")


class User(Base):
    """Maps to the 'users' table.  One row = one staff account."""
    __tablename__ = "users"

    id            = Column(Integer, primary_key=True, index=True)
    username      = Column(String(50), unique=True, nullable=False, index=True)
    full_name     = Column(String(120), nullable=False)
    # Optional contact details, editable from the account menu (Profile).
    # nullable=True so old rows created before these columns existed stay valid.
    email         = Column(String(120), nullable=True)
    phone         = Column(String(30),  nullable=True)
    # Relative filename of the uploaded profile photo inside the avatars folder
    # (e.g. "1.jpg").  The bytes live on disk, not in the DB — same pattern as
    # prescription images.  NULL means "no photo, show the generic icon".
    avatar_path   = Column(String(255), nullable=True)
    # We NEVER store the real password.  This column holds the bcrypt hash.
    password_hash = Column(String(255), nullable=False)
    role_id       = Column(Integer, ForeignKey("roles.id"), nullable=False)
    is_active     = Column(Boolean, nullable=False, default=True)
    # server_default tells SQLAlchemy the DB will supply this value (DEFAULT now())
    # so it doesn't send null when we insert a new row.
    created_at    = Column(TIMESTAMP(timezone=True), nullable=False, server_default=func.now())

    # "Lazy" means SQLAlchemy fetches the Role row automatically when you
    # access  user.role  — you don't need to do a second query yourself.
    role = relationship("Role", back_populates="users", lazy="joined")
