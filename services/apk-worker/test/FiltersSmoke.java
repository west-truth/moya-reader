import eu.kanade.tachiyomi.source.model.Filter;
import eu.kanade.tachiyomi.source.model.FilterList;
import org.json.JSONArray;
import org.moya.apk.FiltersKt;
import java.util.List;

class FiltersSmoke {
  public static void main(String[] args) {
    var selection = new Filter.Select<String>("Order", new String[]{"Old", "New"}, 0) {};
    var tag = new Filter.TriState("Tag", 0) {};
    var group = new Filter.Group<Filter<?>>("Tags", List.of(tag)) {};
    var sort = new Filter.Sort("Sort", new String[]{"Title", "Date"}, null) {};
    var filters = new FilterList(selection, group, sort);
    var result = FiltersKt.sourceFilters(filters, new JSONArray("""
      [{"position":0,"value":1},{"position":1,"groupPosition":0,"value":"EXCLUDE"},
       {"position":2,"value":{"index":1,"ascending":true}}]
      """));
    if (selection.getState() != 1 || !tag.isExcluded() || sort.getState().getIndex() != 1 ||
        !sort.getState().getAscending() || filters.get(0) != selection || result.length() != 4)
      throw new AssertionError("original filter state or identity lost");
    try {
      FiltersKt.sourceFilters(filters, new JSONArray("[{\"position\":0,\"value\":12}]"));
      throw new AssertionError("invalid option accepted");
    } catch (IllegalArgumentException expected) {}
    System.out.println("APK filter mapping passed");
  }
}
