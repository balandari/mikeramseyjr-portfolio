/** Decorative book depth and spine for the homepage. The cover and all
 * meaningful text remain HTML; home.css supplies perspective and texture. */
export default function StudyBook({
  size,
  children,
  title,
}: {
  size: "featured" | "shelf";
  children: React.ReactNode;
  title?: string;
}) {
  return (
    <span className={`ms-study-book ms-study-book--${size}`}>
      {title ? <span className="ms-study-spine" aria-hidden="true">{title}</span> : null}
      {children}
    </span>
  );
}
