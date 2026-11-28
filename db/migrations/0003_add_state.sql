-- state: state, province or territory as a full name ("New South Wales"), never a code.
alter table jobs     add column state text;
alter table profiles add column state text;
