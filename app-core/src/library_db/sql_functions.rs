use diesel::sql_types::{BigInt, Double, Nullable, Text};

pub(crate) type NullableText = Nullable<Text>;

diesel::postfix_operator!(NoCase, " COLLATE NOCASE", Text, backend: diesel::sqlite::Sqlite);
diesel::prefix_operator!(CastOpen, "CAST(", Double, backend: diesel::sqlite::Sqlite);
diesel::postfix_operator!(CastInteger, " AS INTEGER)", BigInt, backend: diesel::sqlite::Sqlite);

diesel::define_sql_function! {
    fn unicode_lower(input: Text) -> Text;
}

diesel::define_sql_function! {
    #[sql_name = "json_extract"]
    fn json_extract_text(json: Text, path: Text) -> NullableText;
}
