# Import all models here so SQLAlchemy can see them when it needs to resolve
# relationships between tables. Add each new model file's import here as you
# build more modules.
from app.models.user import Role, User  # noqa: F401
from app.models.inventory import (  # noqa: F401
    Category, Department, Supplier, Product, Batch, StockMovement, StockPurchase,
)
from app.models.patients import Patient, Tag  # noqa: F401
from app.models.billing import Invoice, InvoiceItem, AuditLog, DocCounter  # noqa: F401
from app.models.prescription import Prescription  # noqa: F401
from app.models.credit import CreditAccount, CreditTransaction, CreditReminder  # noqa: F401
from app.models.expenditure import (  # noqa: F401
    Employee, Expense, SalaryRecord, CashRegister,
)
# Supplier-side credit (money WE owe suppliers), expired-stock returns, and the
# home-visit charge settings row.  Mirror image of models/credit.py, which
# tracks money patients owe US.
from app.models.supplier_credit import (  # noqa: F401
    SupplierCreditAccount, SupplierCreditTransaction, SupplierPaymentReminder,
    SupplierReturn, HomeVisitCharge,
)
# Shop-wide identity (name, tagline, address, GSTIN, DL number).  One row, read
# by the sidebar, the login screen, the receipt and the browser tab title.
from app.models.settings import PharmacySettings  # noqa: F401
