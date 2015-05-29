/**
 * airbnb Node wrapper for unofficial API
 * @author Si Pham <phamtrisi@gmail.com>
 * 
 * Support basic actions to interact with airbnb hostings
 * - search() - Search for hostings given conditions
 * - info() - Get info about a hosting
 * - availability() - Get availability for a hosting
 * - income() - Get estimate income a hosting generates, by month
 * - reviews() - Get reviews for a given user, as host or guest
 */
var request = require('request'),
  _ = require('lodash'),
  cheerio = require('cheerio'),
  secrets = require('./_secrets');

var api = (function api() {
  var today = new Date(),
    tomorrow = new Date(today.getTime() + 24 * 60 * 60 * 1000),
    API_KEY = secrets.API_KEY,
    DEFAULT_REQUEST_CONFIGS = secrets.DEFAULT_REQUEST_CONFIGS,
    DEFAULT_REQUEST_PARAMS = {
      key: API_KEY
    },
    DEFAULT_AVAILABILITY_PARAMS = _.assign({}, DEFAULT_REQUEST_PARAMS, {
      currency: 'USD',
      locale: 'en',
      month: today.getMonth() + 1,
      year: today.getFullYear(),
      count: 3,
      _format: 'with_conditions'
    }),
    DEFAULT_REVIEWS_PARAMS = _.assign({}, DEFAULT_REQUEST_PARAMS, {
      page: 1,
      role: 'host'
    }),
    AIRBNB_PREFIX = 'https://www.airbnb.com',
    SEARCH_URL = AIRBNB_PREFIX + '/search/search_results',
    AVAILABILITY_URL = AIRBNB_PREFIX + '/api/v2/calendar_months',
    HOSTING_INFO_URL = AIRBNB_PREFIX + '/api/v1/listings',
    USER_REVIEWS_URL = AIRBNB_PREFIX + '/users/review_page';

  /**
   * HELPERS
   */

  /**
   * Serialize an object into a valid URL string
   * @param  {Object} obj - Params object
   * @return {String} - A valid encoded URL string
   */
  function _serialize(obj) {
    var params = [],
      encodedBrackets = encodeURIComponent('[]');

    _.forOwn(obj, function(value, key) {
      if (typeof value === 'string' ||
        typeof value === 'number' ||
        typeof value === 'boolean') {
        params.push(key + '=' + encodeURIComponent(value));
      } else if (typeof value === 'object' && Array.isArray(value)) {
        params.push(value.map(function(param) {
          return key + encodedBrackets + '=' + encodeURIComponent(param);
        }).join('&'));
      }
    });

    return params.join('&');
  }

  /**
   * Functions used in .filter and .reduce
   */

  function _filled(day) {
    return !day.available && day.type === 'reservation';
  }

  function _hasPrice(day) {
    return day.price !== null;
  }

  function _sumPrice(sum, day) {
    return sum + day.price.local_price;
  }

  function _available(day) {
    return day.available;
  }

  function _hostBusy(day) {
    return !day.available && day.type === 'busy' && day.subtype === 'host_busy';
  }

  /**
   * Return the first match in a collection given a predicate
   * @param  {Array} collection - Array of objects to iterate on
   * @param  {Function} predicate - Function to invoke on every element of the collection. Must return true or false
   * @return {Object, undefined} - First item in collection that predicate() returns true on. If there's no match, returns undefined.
   */
  function _firstMatch(collection, predicate) {
    var i = 0,
      len = collection.length;

    if (len === 0) return;

    for (; i < len; i += 1) {
      if (predicate(collection[i]) === true) {
        return collection[i];
      }
    }

    return;
  }

  /**
   * Extract hosting info given a cheerio parsed HTML body
   * @param  {cheerio parsed HTML body} parsedBody
   * @return {Object} - Hosting info in JSON form
   *
   * info = {
   *   title: {String} - Hosting title
   *   truncatedDescription: {String} - Short description of the hosting
   *   metaData: {Object, null} - Metadata found on airbnb hosting page
   * }
   */
  function _extractInfo(parsedBody) {
    var $ = parsedBody,
      title = $('title').text(), // Hosting title
      truncatedDescription = $('meta[name=description]').attr('content'),
      $metas = $('meta'),
      // TODO Find a more robust way to pick out the meta tag that houses these info
      $hostingInfoMeta = _firstMatch($metas, function($meta) {
        // Meta tag needs to have 'attribs' and 'content' properties
        if (!($meta.hasOwnProperty('attribs') && $meta.attribs.hasOwnProperty('content'))) {
          return false;
        }

        var content = $meta.attribs.content;

        try {
          content = JSON.parse(content);
          if (content.hasOwnProperty('locale') &&
            content.hasOwnProperty('hostingId')) {
            return true;
          }
        } catch (e) {
          console.err(e);
          return false;
        }

        return false;
      });

    return {
      title: title,
      truncatedDescription: truncatedDescription,
      metaData: $hostingInfoMeta ? JSON.parse($hostingInfoMeta.attribs.content) : null
    };
  }

  /**
   * MAIN METHODS
   */

  /**
   * Search hostings
   * @param  {Object} options - Search options
   * @param  {Function} successCallback(err, res, listings) - Callback to invoke if successful 
   * @param  {Function} failureCallback(err, res) - Callback to invoke if failed 
   * @return {Void} - List of found hostings is passed through callbacks
   *
   * Available options 
   * options = {
   *   checkin: {String},
   *   checkout: {String},
   *   guests: {Number},
   *   page: {Number},
   *   location: {String}, e.g: 'New York, NY' or 'Seattle, WA'
   *   price_min: {Number},
   *   price_max: {Number},
   *   min_bedrooms: {Number},
   *   min_bathrooms: {Number},
   *   min_beds: {Number},
   *   superhost: {Boolean},
   *   hosting_amenities: {Array of id}, e.g: [1,4]
   *   property_type_id: {Array of id}, e.g: [1]
   *   languages: {Array of id}, e.g: [1,64]
   *   keywords: {String}, e.g: 'ocean,view,balcony'
   *   room_types: {Array}, e.g: ['Entire home/apt', 'Private room', 'Shared room']
   *   ib: {Boolean}, instant-book,
   *   neighborhoods: {Array}, e.g: ['Belltown', 'Queen Anne']
   * }
   */
  function search(options, successCallback, failureCallback) {
    // Make sure search options is provided
    if (!options || !_.isObject(options)) {
      throw new Error('Must provide search options');
    }

    var requestConfigs = _.assign({}, DEFAULT_REQUEST_CONFIGS, {
      url: SEARCH_URL + '?' + _serialize(options)
    }),
      hostings = [];

    // Make request
    request(requestConfigs, function(err, res, body) {
      if (!err && res.statusCode == 200 && _.isFunction(successCallback)) {
        body = JSON.parse(body);
        
        try {
          hostings = body.logging_info.search.result.hostingIds.map(function(hosting) {
            return hosting;
          });
        }
        catch(err) {
          hostings = [];
        }
        successCallback(hostings, body);
      } else if (err && _.isFunction(failureCallback)) {
        failureCallback(err, res);
      }
    });
  }


  /**
   * Get availability for a given hosting ID
   * @param  {[Number/String]} hosting ID         [description]
   * @param  {[Object]} options         [description]
   * @param  {Function} successCallback(err, res, info) - Callback to invoke if successful 
   * @param  {Function} failureCallback(err, res) - Callback to invoke if failed 
   * @return {Void} - Listing info is passed through callbacks
   *
   * Available options
   * options = {
   *   key: {String}, provide your own API key if you have, otherwise leave this as default
   *   currency: {String}, e.g: 'USD' or 'VND'
   *   locale: {String}, e.g: 'en'
   *   month: {Number/String}, 1-based. E.g: July = 7
   *   year: {Number/String},
   *   count: {Number}, // Get <x> months of availabilities starting at <month>
   * }
   */
  function availability(hostingId, options, successCallback, failureCallback) {
    // Make sure we have enough params to continue
    if (arguments.length < 2) {
      throw new Error('Must provide hosting ID and search options');
    }

    if (!_.isNumber(hostingId) &&
      !_.isString(hostingId)) {
      throw new Error('Hosting ID must be string or int');
    }

    var searchOptions = _.assign({
        listing_id: hostingId
      }, DEFAULT_AVAILABILITY_PARAMS, options),
      requestConfigs = _.assign({}, DEFAULT_REQUEST_CONFIGS, {
        url: AVAILABILITY_URL + '?' + _serialize(searchOptions)
      });

    // Make request
    request(requestConfigs, function(err, res, body) {
      if (!err && res.statusCode == 200 && _.isFunction(successCallback)) {
        successCallback(JSON.parse(body));
      } else if (err && _.isFunction(failureCallback)) {
        failureCallback(err, res);
      }
    });
  }

  /**
   * Generate estimate income for a particular hosting
   * @param  {Number, String} hosting - Hosting ID
   * @param  {Object} options - Search options, similar to options for .availability()
   * @param  {Function} successCallback - Callback to invoke when successfully calculating est income
   * @param  {Function} failureCallback - Failure callback to invoke
   * @return {Void} - Estimate income is passed onto callbacks
   */
  function income(hosting, options, successCallback, failureCallback) {
    availability(hosting, options, function success(err, res, availabilityInfo) {
      // Process data here
      var estIncome = availabilityInfo.calendar_months.map(function(thisMonth) {
        var days = thisMonth.days,
          daysWithPrice = days.filter(_hasPrice),
          daysAvailable = days.filter(_available),
          daysHostBusy = days.filter(_hostBusy),
          daysReserved = days.filter(_filled),
          avgPrice = daysWithPrice.length ? daysWithPrice.reduce(_sumPrice, 0) / daysWithPrice.length : 0;

        return {
          month: thisMonth.month,
          year: thisMonth.year,
          daysAvailable: daysAvailable.length,
          daysHostBusy: daysHostBusy.length,
          daysReserved: daysReserved.length,
          avgPrice: avgPrice,
          estIncome: avgPrice * daysReserved.length,
          estOpportunityIncome: avgPrice * daysAvailable.length
        };
      });

      if (typeof successCallback === 'function') {
        successCallback(estIncome);
      }
    }, function failure(err, res) {
      if (typeof failureCallback === 'function') {
        failureCallback(err, res);
      }
    });
  }

  /**
   * Get info for a particular hosting
   * @param  {Number, String} hosting - Hosting ID
   * @param  {Function} successCallback - Success callback to invoke
   * @param  {Function} failureCallback - Failure callback to invoke
   * @return {Void} - Hosting info is passed onto callbacks
   */
  function info(hosting, successCallback, failureCallback) {
    var requestConfigs = _.assign({}, DEFAULT_REQUEST_CONFIGS, {
      url: HOSTING_INFO_URL + '/' + hosting + '?' + _serialize({
        key: API_KEY
      })
    });

    // Make request to parse hosting info
    request(requestConfigs, function(err, res, body) {
      if (!err && res.statusCode == 200 && typeof successCallback === 'function') {
        successCallback(JSON.parse(body));
      } else if (err && typeof failureCallback === 'function') {
        failureCallback(err, res);
      }
    });
  }


  /**
   * Get a list of textual reviews for a given user, as a host or a guest
   * @param  {Number, String} user - User ID
   * @param  {Object} options - Options to specify page and role of reviews
   * @param  {Function} successCallback
   * @param  {Function} failureCallback
   * @return {Void} - List of reviews is passed onto callbacks
   *
   * options = {
   *   page: {Number}, default 1
   *   role: {String}, Either 'guest' or 'host', default to 'host'
   * }
   */
  function reviews(userId, options, successCallback, failureCallback) {
    var searchOptions = _.assign({}, DEFAULT_REVIEWS_PARAMS, options),
      requestConfigs = _.assign({}, DEFAULT_REQUEST_CONFIGS, {
        url: USER_REVIEWS_URL + '/' + userId + '?' + _serialize(searchOptions)
      }),
      reviews = [],
      $;

    // Make request to get user reviews
    request(requestConfigs, function(err, res, body) {
      if (!err && res.statusCode == 200 && _.isFunction(successCallback)) {
        try {
          // Since the res is in HTML, parse with cheerio
          $ = cheerio.load(JSON.parse(body).review_content);

          // Construct list of textual reviews
          $('.comment-container .expandable-content p').each(function(idx, $review) {
            reviews.push($review.children[0].data);
          });

          // Invoke success callback
          successCallback(reviews);
        } catch (err) {
          if (_.isFunction(failureCallback)) {
            failureCallback(err, res);
          }
        }
      } else if (err && _.isFunction(failureCallback)) {
        failureCallback(err, res);
      }
    });
  }


  // Expose public methods
  return {
    search: search,
    availability: availability,
    income: income,
    info: info,
    reviews: reviews
  };
})();

module.exports = api;