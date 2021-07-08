export default (props: { children?: string }) => {
  document.title = props.children || "";
  return null;
};
